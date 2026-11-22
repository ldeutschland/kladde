use super::Local;
use super::batches::sync_docs;
use super::deletions::listed_among;
use super::doc_exchange::exchange_if_needed;
use super::doc_state_keys::{DocKeys, read_cursor};
use super::marks::mark_key;
use super::relay_link::Link;
use super::report::Report;
use crate::{Error, account::Access};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub(super) fn listings_current(
    local: &impl Local,
    access: &Access,
    listings: &BTreeSet<Uuid>,
    remote: &BTreeMap<Uuid, i64>,
) -> Result<bool, Error> {
    for id in listings {
        let Some(seq) = remote.get(id).copied() else {
            continue;
        };

        let keys = DocKeys::new(access, *id);

        if local.with(|store| read_cursor(store, &keys.head))?.seq < seq {
            return Ok(false);
        }
    }

    Ok(true)
}

pub(super) fn wanted_listings(
    local: &impl Local,
    access: &Access,
    wanted: impl Fn(&Uuid) -> bool,
) -> Result<BTreeSet<Uuid>, Error> {
    let mut listings: BTreeSet<Uuid> = local
        .with(|store| store.listings(access.space))?
        .into_iter()
        .collect();

    listings.insert(access.space);
    listings.retain(|id| wanted(id));

    Ok(listings)
}

pub(super) async fn sync_listings(
    local: &impl Local,
    link: &mut Link<'_>,
    listings: &BTreeSet<Uuid>,
    remote: &BTreeMap<Uuid, i64>,
    outbox: &BTreeSet<Uuid>,
    report: &mut Report,
) -> Result<Vec<Uuid>, Error> {
    let access = link.access;
    let held = local.with(|store| store.deletions(access.space))?;
    let before = listed_among(local, access.space, held)?.0;

    if listings.contains(&access.space) {
        let seq = remote.get(&access.space).copied();

        exchange_if_needed(local, link, seq, outbox, access.space, report).await?;
    }

    let shards: BTreeSet<Uuid> = listings
        .iter()
        .copied()
        .filter(|id| *id != access.space)
        .collect();
    sync_docs(local, link, &shards, remote, outbox, report).await?;

    revive_relisted(local, access, &before)
}

fn revive_relisted(
    local: &impl Local,
    access: &Access,
    before: &BTreeSet<Uuid>,
) -> Result<Vec<Uuid>, Error> {
    let held = local.with(|store| store.deletions(access.space))?;
    let (listed, _) = listed_among(local, access.space, held)?;
    let mut revived = Vec::new();

    for id in listed.difference(before).copied() {
        let keys = DocKeys::new(access, id);

        local.with(|store| {
            store.revive(access.space, id)?;
            store.clear_state(&keys.head)?;
            store.clear_state(&keys.pending)?;

            store.clear_state(&mark_key(access))
        })?;
        revived.push(id);
    }

    Ok(revived)
}
