use super::batches::{NeededStep, needed_step};
use super::doc_state_keys::{DocKeys, read_cursor};
use super::pending_pushes::{Outcome, confirm_acknowledged, prepare_push, settle_push_reply};
use super::relay_link::Link;
use super::report::{
    Report, report_changed, report_damaged, report_newer_format, stop_for_full_storage,
};

use super::{Local, local_error};
use crate::{Cursor, Error, Socket, Writing, account::Access};
use kladde_protocol::{self as p, Client, Envelope, Server};
use kladde_store::{Incoming, Note};
use std::collections::BTreeSet;
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
            Err(Error::Newer) => return Err(Error::Newer),
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
    let mut incoming = Incoming::default();
    let mut damaged = false;
    let received = collect_items(socket, access, keys, cursor, &mut incoming, &mut damaged).await;

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

async fn collect_items(
    socket: &mut Socket,
    access: &Access,
    keys: &DocKeys,
    cursor: &mut Cursor,
    incoming: &mut Incoming,
    damaged: &mut bool,
) -> Result<(), Error> {
    loop {
        match socket.receive().await? {
            Server::Item {
                seq,
                envelope,
                certificate,
            } => {
                let mut next = cursor.clone();
                let note = match open_item(access, keys, &mut next, seq, &envelope, &certificate) {
                    Err(Error::Newer) => return skip_newer(socket, keys).await,
                    opened => opened?,
                };

                match incoming.add(note) {
                    Ok(()) => {}
                    Err(kladde_store::Error::Invalid) => *damaged = true,
                    Err(e) => return Err(local_error(e)),
                }

                *cursor = next;
            }
            Server::Head { doc, seq } if doc == keys.id && seq == cursor.seq => return Ok(()),
            Server::Outdated { doc } if doc == keys.id => return Err(Error::Newer),
            Server::Ephemeral(_) => continue,
            _ => return Err(Error::Conflict),
        }
    }
}

async fn skip_newer(socket: &mut Socket, keys: &DocKeys) -> Result<(), Error> {
    loop {
        match socket.receive().await? {
            Server::Item { .. } | Server::Ephemeral(_) => continue,
            Server::Head { doc, .. } if doc == keys.id => return Err(Error::Newer),
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
