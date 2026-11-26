use super::batches::{NeededStep, needed_step};
use super::closings::{CoveredHead, covered_heads, forget_chains};
use super::doc_state_keys::{DocKeys, read_cursor};
use super::pending_pushes::{Outcome, confirm_acknowledged, prepare_push, settle_push_reply};
use super::relay_link::Link;
use super::report::{
    Report, report_changed, report_damaged, report_newer_format, stop_for_full_storage,
};

use super::{Local, local_error};
use crate::{Cursor, Error, Socket, Writing, account::Access};
use kladde_protocol::{self as p, Client, Envelope, Header, Server};
use kladde_store::{Incoming, Note};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const ATTEMPTS: usize = 3;

const PUSHES: usize = 2;

pub(super) async fn exchange_if_needed(
    local: &impl Local,
    link: &mut Link<'_>,
    remote_seq: Option<i64>,
    outbox: &BTreeSet<Uuid>,
    id: Uuid,
    report: &mut Report,
) -> Result<(), Error> {
    if needed_step(local, link.access, id, remote_seq, outbox)? == NeededStep::Nothing {
        return Ok(());
    }

    exchange_doc(local, link, id, report).await
}

pub(super) async fn exchange_doc(
    local: &impl Local,
    link: &mut Link<'_>,
    id: Uuid,
    report: &mut Report,
) -> Result<(), Error> {
    match sync_reliably(local, link, id, report).await {
        Ok(true) => report_changed(local, report, id),
        Ok(false) => {}
        Err(Error::Stale) => report.retry.push(id),
        Err(Error::Full) => stop_for_full_storage(report, id),
        Err(Error::Newer) => report_newer_format(local, report, id),
        Err(
            e @ (Error::Network | Error::Busy | Error::Auth | Error::Storage | Error::Outdated(_)),
        ) => return Err(e),
        Err(_) => report.failed.push(id),
    }

    Ok(())
}

async fn sync_reliably(
    local: &impl Local,
    link: &mut Link<'_>,
    id: Uuid,
    report: &mut Report,
) -> Result<bool, Error> {
    let access = link.access;
    let writing = link.writing;
    let mut last = Error::Stale;

    for _ in 0..ATTEMPTS {
        let socket = link.socket().await?;

        match sync_doc(socket, access, local, id, writing, report).await {
            Err(Error::Stale) => last = Error::Stale,
            Err(e @ (Error::Newer | Error::Uncovered)) => return Err(e),
            Err(Error::Network) => {
                link.reset();
                last = Error::Network;
            }
            Err(Error::Full) => return Err(Error::Full),
            Err(e) => {
                link.reset();

                return Err(e);
            }
            done => return done,
        }
    }

    Err(match last {
        Error::Network => Error::Denied,
        other => other,
    })
}

pub(super) async fn subscribe(
    socket: &mut Socket,
    access: &Access,
    keys: &DocKeys,
    cursor: &Cursor,
) -> Result<(), Error> {
    socket
        .send(&Client::Subscribe {
            space: access.space,
            doc: keys.id,
            last_seq: cursor.seq,
            known_snapshot: cursor.snapshot,
        })
        .await
}

pub(super) async fn pull(
    socket: &mut Socket,
    access: &Access,
    local: &impl Local,
    keys: &DocKeys,
    cursor: &mut Cursor,
    report: &mut Report,
) -> Result<(), Error> {
    subscribe(socket, access, keys, cursor).await?;

    receive_pull(socket, access, local, keys, cursor, report).await
}

pub(super) async fn receive_pull(
    socket: &mut Socket,
    access: &Access,
    local: &impl Local,
    keys: &DocKeys,
    cursor: &mut Cursor,
    report: &mut Report,
) -> Result<(), Error> {
    let start = cursor.seq;
    let covered = covered_heads(local, access, keys.id)?;
    let mut incoming = Incoming::default();
    let mut damaged = false;
    let received = collect_items(
        socket,
        access,
        keys,
        cursor,
        &mut incoming,
        &mut damaged,
        &covered,
    )
    .await;

    if matches!(received, Err(Error::Uncovered)) {
        forget_chains(local, access)?;
    }

    if cursor.seq == start {
        return received;
    }

    let head = p::encode(cursor)?;
    let merged = local.with(|store| Ok(store.merge_all(incoming, &keys.head, &head)))?;

    match merged {
        Ok(true) => report_changed(local, report, keys.id),
        Ok(false) => {}
        Err(kladde_store::Error::Invalid) => {
            local.with(|store| store.set_state(&keys.head, &head))?;
            damaged = true;
        }
        Err(e) => return Err(local_error(e)),
    }

    if damaged {
        report_damaged(report, keys.id);
    }

    received
}

pub(super) async fn collect_items(
    socket: &mut Socket,
    access: &Access,
    keys: &DocKeys,
    cursor: &mut Cursor,
    incoming: &mut Incoming,
    damaged: &mut bool,
    covered: &[CoveredHead],
) -> Result<(), Error> {
    let mut pull = Pull {
        access,
        keys,
        covered,
        working: cursor.clone(),
        held: BTreeMap::new(),
    };

    loop {
        match socket.receive().await? {
            Server::Item {
                seq,
                envelope,
                certificate,
            } => {
                match pull.receive(seq, &envelope, &certificate, incoming, damaged) {
                    Err(e @ (Error::Newer | Error::Uncovered)) => {
                        return skip_rest(socket, keys, e).await;
                    }
                    received => received?,
                }

                if pull.held.is_empty() {
                    *cursor = pull.working.clone();
                }
            }
            Server::Head { doc, seq } if doc == keys.id && seq == pull.working.seq => {
                return if pull.held.is_empty() {
                    Ok(())
                } else {
                    Err(Error::Uncovered)
                };
            }
            Server::Outdated { doc } if doc == keys.id => return Err(Error::Newer),
            Server::Ephemeral(_) => continue,
            _ => return Err(Error::Conflict),
        }
    }
}

struct Pull<'a> {
    access: &'a Access,
    keys: &'a DocKeys,
    covered: &'a [CoveredHead],
    working: Cursor,
    held: BTreeMap<Uuid, Vec<Note>>,
}

impl Pull<'_> {
    fn receive(
        &mut self,
        seq: i64,
        envelope: &Envelope,
        certificate: &p::Certificate,
        incoming: &mut Incoming,
        damaged: &mut bool,
    ) -> Result<(), Error> {
        let mut next = self.working.clone();
        let note = open_item(
            self.access,
            self.keys,
            &mut next,
            seq,
            envelope,
            certificate,
        )?;
        let device = envelope.header.device;

        if predates_identity(self.access, &envelope.header)? {
            let head = next.heads.get(&device).copied().ok_or(Error::Conflict)?;

            self.hold(device, head, note, incoming, damaged)?;
        } else {
            take(incoming, note, damaged)?;
        }

        self.working = next;

        Ok(())
    }

    fn hold(
        &mut self,
        device: Uuid,
        head: (u64, [u8; 32]),
        note: Note,
        incoming: &mut Incoming,
        damaged: &mut bool,
    ) -> Result<(), Error> {
        let listed: Vec<(u64, [u8; 32])> = self
            .covered
            .iter()
            .filter(|(owner, ..)| *owner == device)
            .map(|(_, counter, hash)| (*counter, *hash))
            .collect();

        if !listed.iter().any(|(counter, _)| head.0 <= *counter) {
            return Err(Error::Uncovered);
        }

        self.held.entry(device).or_default().push(note);

        if listed.contains(&head) {
            for confirmed in self.held.remove(&device).unwrap_or_default() {
                take(incoming, confirmed, damaged)?;
            }
        }

        Ok(())
    }
}

fn predates_identity(access: &Access, header: &Header) -> Result<bool, Error> {
    let (_, identity) = access.epoch_keys(header.epoch)?;

    Ok(identity.to_bytes() != access.identity)
}

fn take(incoming: &mut Incoming, note: Note, damaged: &mut bool) -> Result<(), Error> {
    match incoming.add(note) {
        Ok(()) => Ok(()),
        Err(kladde_store::Error::Invalid) => {
            *damaged = true;

            Ok(())
        }
        Err(e) => Err(local_error(e)),
    }
}

async fn skip_rest(socket: &mut Socket, keys: &DocKeys, error: Error) -> Result<(), Error> {
    loop {
        match socket.receive().await? {
            Server::Item { .. } | Server::Ephemeral(_) => continue,
            Server::Head { doc, .. } if doc == keys.id => return Err(error),
            _ => return Err(Error::Conflict),
        }
    }
}

fn open_item(
    access: &Access,
    keys: &DocKeys,
    cursor: &mut Cursor,
    seq: i64,
    envelope: &Envelope,
    certificate: &p::Certificate,
) -> Result<Note, Error> {
    let bytes = cursor.accept(access, keys.id, seq, envelope, certificate)?;
    let note: Note = p::decode(&bytes)?;

    if note.space != access.space || note.id != keys.id {
        return Err(Error::Conflict);
    }

    Ok(note)
}

async fn sync_doc(
    socket: &mut Socket,
    access: &Access,
    local: &impl Local,
    id: Uuid,
    writing: Writing,
    report: &mut Report,
) -> Result<bool, Error> {
    let keys = DocKeys::new(access, id);
    let mut cursor = local.with(|store| read_cursor(store, &keys.head))?;

    pull(socket, access, local, &keys, &mut cursor, report).await?;
    let mut pushed = false;

    for _ in 0..PUSHES {
        let Some(pending) = prepare_push(local, access, &keys, &cursor, writing)? else {
            break;
        };

        socket.send(&pending.request).await?;
        let reply = socket.receive().await?;

        if settle_push_reply(local, access, &keys, &mut cursor, &pending, reply)? == Outcome::Behind
        {
            pull(socket, access, local, &keys, &mut cursor, report).await?;
            confirm_acknowledged(local, access, &keys, &cursor, &pending)?;
        }

        pushed = true;
    }

    Ok(pushed)
}
