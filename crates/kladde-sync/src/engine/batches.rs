use super::Local;
use super::doc_exchange::{exchange_doc, receive_pull, subscribe};
use super::doc_state_keys::{DocKeys, read_cursor};
use super::pending_pushes::{Outcome, Pending, prepare_push, settle_push_reply};
use super::relay_link::Link;
use super::report::{Report, report_changed, report_newer_format, stop_for_full_storage};
use crate::{Cursor, Error, Socket, account::Access};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const BATCH: usize = 16;

fn waits_again(local: &impl Local, id: Uuid) -> Result<bool, Error> {
    local.with(|store| Ok(store.queued(id)?.is_some()))
}

pub(super) async fn sync_docs(
    local: &impl Local,
    link: &mut Link<'_>,
    docs: &BTreeSet<Uuid>,
    remote: &BTreeMap<Uuid, i64>,
    outbox: &BTreeSet<Uuid>,
    report: &mut Report,
) -> Result<(), Error> {
    let mut pulls = Vec::new();
    let mut pushes = Vec::new();

    for &id in docs {
        match needed_step(local, link.access, id, remote.get(&id).copied(), outbox)? {
            NeededStep::Nothing => {}
            NeededStep::Pull => pulls.push(id),
            NeededStep::Exchange => pushes.push(id),
        }
    }

    for batch in pushes.chunks(BATCH) {
        for id in exchange_batch(local, link, batch, report).await {
            exchange_doc(local, link, id, report).await?;
        }
    }

    for batch in pulls.chunks(BATCH) {
        let done = pull_batch(local, link, batch, report).await;

        for &id in &batch[done..] {
            exchange_doc(local, link, id, report).await?;
        }
    }

    Ok(())
}

#[derive(PartialEq, Eq)]
pub(super) enum NeededStep {
    Nothing,
    Pull,
    Exchange,
}

pub(super) fn needed_step(
    local: &impl Local,
    access: &Access,
    id: Uuid,
    remote_seq: Option<i64>,
    outbox: &BTreeSet<Uuid>,
) -> Result<NeededStep, Error> {
    if outbox.contains(&id) {
        return Ok(NeededStep::Exchange);
    }

    let keys = DocKeys::new(access, id);
    let (cursor, pending) = local.with(|store| {
        let cursor = read_cursor(store, &keys.head)?;

        Ok((cursor, store.state(&keys.pending)?.is_some()))
    })?;

    if pending || cursor.needs_rekey_snapshot(access) {
        return Ok(NeededStep::Exchange);
    }

    let differs = match remote_seq {
        None => cursor.seq > 0,
        Some(seq) => seq != cursor.seq,
    };

    Ok(if differs {
        NeededStep::Pull
    } else {
        NeededStep::Nothing
    })
}

async fn pull_batch(
    local: &impl Local,
    link: &mut Link<'_>,
    ids: &[Uuid],
    report: &mut Report,
) -> usize {
    let mut done = 0;

    if pull_each(local, link, ids, report, &mut done)
        .await
        .is_err()
    {
        link.reset();
    }

    done
}

async fn pull_each(
    local: &impl Local,
    link: &mut Link<'_>,
    ids: &[Uuid],
    report: &mut Report,
    done: &mut usize,
) -> Result<(), Error> {
    let access = link.access;
    let socket = link.socket().await?;

    for (keys, mut cursor) in subscribe_all(socket, access, local, ids).await? {
        match receive_pull(socket, access, local, &keys, &mut cursor, report).await {
            Ok(()) => {}
            Err(Error::Newer) => report_newer_format(local, report, keys.id),
            Err(e) => return Err(e),
        }
        *done += 1;
    }

    Ok(())
}

async fn subscribe_all(
    socket: &mut Socket,
    access: &Access,
    local: &impl Local,
    ids: &[Uuid],
) -> Result<Vec<(DocKeys, Cursor)>, Error> {
    let mut cursors = Vec::with_capacity(ids.len());

    for &id in ids {
        let keys = DocKeys::new(access, id);
        let cursor = local.with(|store| read_cursor(store, &keys.head))?;

        subscribe(socket, access, &keys, &cursor).await?;
        cursors.push((keys, cursor));
    }

    Ok(cursors)
}

async fn exchange_batch(
    local: &impl Local,
    link: &mut Link<'_>,
    ids: &[Uuid],
    report: &mut Report,
) -> Vec<Uuid> {
    let mut done = BTreeSet::new();

    if push_each(local, link, ids, report, &mut done)
        .await
        .is_err()
    {
        link.reset();
    }

    ids.iter()
        .filter(|id| !done.contains(*id))
        .copied()
        .collect()
}

struct Prepared {
    keys: DocKeys,
    cursor: Cursor,
    pending: Pending,
}

async fn pull_and_prepare(
    local: &impl Local,
    link: &mut Link<'_>,
    ids: &[Uuid],
    report: &mut Report,
    done: &mut BTreeSet<Uuid>,
) -> Result<Vec<Prepared>, Error> {
    let access = link.access;
    let writing = link.writing;
    let socket = link.socket().await?;
    let mut prepared = Vec::with_capacity(ids.len());

    for (keys, mut cursor) in subscribe_all(socket, access, local, ids).await? {
        match receive_pull(socket, access, local, &keys, &mut cursor, report).await {
            Ok(()) => {}
            Err(Error::Newer) => {
                report_newer_format(local, report, keys.id);
                done.insert(keys.id);
                continue;
            }
            Err(e) => return Err(e),
        }

        match prepare_push(local, access, &keys, &cursor, writing)? {
            Some(pending) => prepared.push(Prepared {
                keys,
                cursor,
                pending,
            }),
            None => {
                done.insert(keys.id);
            }
        }
    }

    Ok(prepared)
}

async fn push_each(
    local: &impl Local,
    link: &mut Link<'_>,
    ids: &[Uuid],
    report: &mut Report,
    done: &mut BTreeSet<Uuid>,
) -> Result<(), Error> {
    let prepared = pull_and_prepare(local, link, ids, report, done).await?;
    let access = link.access;
    let socket = link.socket().await?;

    for item in &prepared {
        socket.send(&item.pending.request).await?;
    }

    for mut item in prepared {
        let reply = socket.receive().await?;
        let id = item.keys.id;

        match settle_push_reply(
            local,
            access,
            &item.keys,
            &mut item.cursor,
            &item.pending,
            reply,
        ) {
            Ok(Outcome::Adopted) => {
                report_changed(local, report, id);

                if !waits_again(local, id)? {
                    done.insert(id);
                }
            }

            Ok(Outcome::Behind) | Err(Error::Stale) => {}
            Err(Error::Full) => {
                done.insert(id);
                stop_for_full_storage(report, id);
            }

            Err(e) => return Err(e),
        }
    }

    Ok(())
}
