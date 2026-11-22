use super::Local;
use super::doc_state_keys::DocKeys;
use crate::{Cursor, Error, Writing, account::Access};
use kladde_crypto as c;
use kladde_protocol::{self as p, Client, Envelope, Server};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
pub(super) struct Pending {
    pub(super) rev: i64,
    pub(super) request: Client,
}

pub(super) fn envelope(req: &Client) -> Result<&Envelope, Error> {
    match req {
        Client::PushUpdate(e) | Client::PushSnapshot { envelope: e, .. } => Ok(e),
        _ => Err(Error::Conflict),
    }
}

fn read_pending(local: &impl Local, keys: &DocKeys) -> Result<Option<Pending>, Error> {
    local
        .with(|store| store.state(&keys.pending))?
        .map(|b| p::decode::<Pending>(&b))
        .transpose()
        .map_err(Error::from)
}

pub(super) fn acknowledge(
    local: &impl Local,
    access: &Access,
    keys: &DocKeys,
    rev: i64,
) -> Result<(), Error> {
    local.with(|store| {
        store.acknowledge(access.space, keys.id, rev)?;

        store.clear_state(&keys.pending)
    })
}

fn settled_pending(
    local: &impl Local,
    access: &Access,
    keys: &DocKeys,
    cursor: &Cursor,
) -> Result<Option<Pending>, Error> {
    let Some(pending) = read_pending(local, keys)? else {
        return Ok(None);
    };

    let env = envelope(&pending.request)?;
    let header = &env.header;

    if header.space != access.space || header.doc != keys.id {
        return Ok(None);
    }

    let head = cursor.heads.get(&header.device);

    if head == Some(&(header.counter, c::hash(env)?)) {
        acknowledge(local, access, keys, pending.rev)?;

        return Ok(None);
    }

    if header.device != access.cert.device || header.epoch != access.epoch() {
        local.with(|store| store.clear_state(&keys.pending))?;

        return Ok(None);
    }

    if head.is_some_and(|(n, _)| *n >= header.counter) {
        return Err(Error::Conflict);
    }

    Ok(Some(pending))
}

pub(super) fn prepare_push(
    local: &impl Local,
    access: &Access,
    keys: &DocKeys,
    cursor: &Cursor,
    writing: Writing,
) -> Result<Option<Pending>, Error> {
    match settled_pending(local, access, keys, cursor)? {
        Some(pending) => Ok(Some(pending)),
        None => queue_outgoing_push(local, access, keys, cursor, writing),
    }
}

fn queue_outgoing_push(
    local: &impl Local,
    access: &Access,
    keys: &DocKeys,
    cursor: &Cursor,
    writing: Writing,
) -> Result<Option<Pending>, Error> {
    let queued = match local.with(|store| store.queued(keys.id))? {
        Some(queued) => Some(queued),
        None if cursor.needs_rekey_snapshot(access) => {
            local.with(|store| store.get(keys.id))?.map(|note| {
                let rev = note.rev;

                (note, rev)
            })
        }
        None => None,
    };

    let Some((note, rev)) = queued.filter(|(note, _)| note.space == access.space) else {
        return Ok(None);
    };

    let bytes = Zeroizing::new(p::encode(&kladde_store::wire_form(note))?);
    let pending = Pending {
        rev,
        request: cursor.push_as(access, keys.id, &bytes, writing)?,
    };

    let encoded = p::encode(&pending)?;

    local.with(|store| store.set_state(&keys.pending, &encoded))?;

    Ok(Some(pending))
}

#[derive(PartialEq, Eq)]
pub(super) enum Outcome {
    Adopted,
    Behind,
}

pub(super) fn settle_push_reply(
    local: &impl Local,
    access: &Access,
    keys: &DocKeys,
    cursor: &mut Cursor,
    pending: &Pending,
    reply: Server,
) -> Result<Outcome, Error> {
    match reply {
        Server::Ack { doc, seq } if doc == keys.id && seq > cursor.seq => {
            if cursor.seq.checked_add(1) != Some(seq) {
                return Ok(Outcome::Behind);
            }

            adopt_acknowledged(local, access, keys, cursor, seq, pending)?;
            confirm_acknowledged(local, access, keys, cursor, pending)?;

            Ok(Outcome::Adopted)
        }
        Server::Conflict => {
            local.with(|store| store.clear_state(&keys.pending))?;

            Err(Error::Stale)
        }
        Server::Full => Err(Error::Full),
        _ => Err(Error::Conflict),
    }
}

fn adopt_acknowledged(
    local: &impl Local,
    access: &Access,
    keys: &DocKeys,
    cursor: &mut Cursor,
    seq: i64,
    pending: &Pending,
) -> Result<(), Error> {
    let sent = envelope(&pending.request)?;

    cursor.accept(access, keys.id, seq, sent, &access.cert)?;
    let head = p::encode(cursor)?;

    local.with(|store| store.set_state(&keys.head, &head))
}

pub(super) fn confirm_acknowledged(
    local: &impl Local,
    access: &Access,
    keys: &DocKeys,
    cursor: &Cursor,
    pending: &Pending,
) -> Result<(), Error> {
    let sent = envelope(&pending.request)?;

    if cursor.heads.get(&access.cert.device) != Some(&(sent.header.counter, c::hash(sent)?)) {
        return Err(Error::Conflict);
    }

    acknowledge(local, access, keys, pending.rev)
}
