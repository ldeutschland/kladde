use super::Local;
use super::batches::sync_docs;
use super::deletions::push_deletions;
use super::doc_exchange::exchange_doc;
use super::listings::{listings_current, sync_listings, wanted_listings};
use super::marks::{has_mark, known_mark, remember_mark};
use super::relay_features::{agree_on_format, handshake, remember_checkpoints};
use super::relay_link::Link;
use super::remote_removals::{orphans_of, remove_deleted};
use super::report::{Report, error_code};
use super::space_state::remote_changes;
use super::untracked_docs::{has_untracked_docs, queue_untracked_docs};
use crate::{Error, account::Access};
use kladde_protocol::account::SpaceState;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub async fn sync_space(
    local: &impl Local,
    client: &reqwest::Client,
    access: &Access,
    state: &SpaceState,
    report: &mut Report,
) {
    let remote: BTreeMap<Uuid, i64> = state.docs.iter().copied().collect();
    let tombstones: BTreeSet<Uuid> = state.deleted.iter().copied().collect();
    let synced = match remember_checkpoints(local, access, state.checkpoints) {
        Ok(()) => sync_all(local, access, &remote, &tombstones, report).await,
        Err(e) => Err(e),
    };

    finish_round(local, client, access, synced, report).await;
}

pub async fn sync_latest(
    local: &impl Local,
    client: &reqwest::Client,
    access: &Access,
    report: &mut Report,
) -> Result<(), Error> {
    let relay = handshake(client, access).await?;

    agree_on_format(local, client, access, &relay, report).await?;
    let after = known_mark(local, access)?;

    if after > 0 && !has_untracked_docs(local, access)? {
        let state = remote_changes(client, access, after, &relay).await?;

        if state.mark.is_some_and(|mark| mark >= after) {
            sync_recent(local, client, access, &state, report).await;

            if report.stopped.is_some() || has_mark(local, access)? {
                return remember_mark(local, access, &state, report);
            }
        }
    }

    let state = remote_changes(client, access, 0, &relay).await?;

    sync_space(local, client, access, &state, report).await;

    remember_mark(local, access, &state, report)
}

async fn sync_recent(
    local: &impl Local,
    client: &reqwest::Client,
    access: &Access,
    state: &SpaceState,
    report: &mut Report,
) {
    let remote: BTreeMap<Uuid, i64> = state.docs.iter().copied().collect();
    let synced = match gone_docs(local, access, state) {
        Ok(gone) => sync_some(local, access, &remote, &BTreeSet::new(), &gone, report).await,
        Err(e) => Err(e),
    };

    finish_round(local, client, access, synced, report).await;
}

fn gone_docs(
    local: &impl Local,
    access: &Access,
    state: &SpaceState,
) -> Result<BTreeSet<Uuid>, Error> {
    remember_checkpoints(local, access, state.checkpoints)?;
    let prefix = format!("rescue:{}:{}:", access.account, access.space);
    let rescued = local.with(|store| store.state_keys(&prefix))?;
    let mut gone: BTreeSet<Uuid> = state.deleted.iter().copied().collect();

    gone.extend(
        rescued
            .iter()
            .filter_map(|key| key[prefix.len()..].parse::<Uuid>().ok()),
    );

    Ok(gone)
}

pub async fn sync_changes(
    local: &impl Local,
    client: &reqwest::Client,
    access: &Access,
    hints: &[(Uuid, i64)],
    report: &mut Report,
) {
    sync_changes_except(local, client, access, hints, &BTreeSet::new(), report).await
}

pub async fn sync_changes_except(
    local: &impl Local,
    client: &reqwest::Client,
    access: &Access,
    hints: &[(Uuid, i64)],
    stuck: &BTreeSet<Uuid>,
    report: &mut Report,
) {
    let remote: BTreeMap<Uuid, i64> = hints.iter().copied().collect();
    let synced = sync_some(local, access, &remote, stuck, &BTreeSet::new(), report).await;

    finish_round(local, client, access, synced, report).await;
}

async fn finish_round(
    local: &impl Local,
    client: &reqwest::Client,
    access: &Access,
    synced: Result<(), Error>,
    report: &mut Report,
) {
    let outcome = match synced {
        Ok(()) => push_deletions(local, client, access).await,
        Err(e) => Err(e),
    };

    match outcome {
        Ok(refused) => report.failed.extend(refused),
        Err(e) => report.stopped = Some(error_code(&e)),
    }

    for ids in [
        &mut report.changed,
        &mut report.removed,
        &mut report.rescue,
        &mut report.failed,
        &mut report.retry,
        &mut report.newer,
    ] {
        let mut seen = BTreeSet::new();

        ids.retain(|id| seen.insert(*id));
    }

    report.waiting = local
        .with(|store| store.outbox(access.space))
        .map_or(0, |ids| ids.len());
}

fn outbox_docs(local: &impl Local, access: &Access) -> Result<BTreeSet<Uuid>, Error> {
    Ok(local
        .with(|store| store.outbox(access.space))?
        .into_iter()
        .collect())
}

fn held_back_docs(local: &impl Local, access: &Access) -> Result<BTreeSet<Uuid>, Error> {
    let mut held: BTreeSet<Uuid> = local
        .with(|store| store.deletions(access.space))?
        .into_iter()
        .collect();

    held.extend(local.with(|store| store.discarding(access.space))?);

    Ok(held)
}

async fn sync_all(
    local: &impl Local,
    access: &Access,
    remote: &BTreeMap<Uuid, i64>,
    tombstones: &BTreeSet<Uuid>,
    report: &mut Report,
) -> Result<(), Error> {
    queue_untracked_docs(local, access, tombstones)?;
    let mut link = Link::open(local, access)?;
    let outbox = outbox_docs(local, access)?;
    let mut doomed = local.with(|store| store.ids(access.space))?;

    doomed.retain(|id| tombstones.contains(id));
    let orphans = orphans_of(local, access, doomed.iter().copied())?;
    let listings = wanted_listings(local, access, |id| !orphans.contains(id))?;

    sync_listings(local, &mut link, &listings, remote, &outbox, report).await?;

    if listings_current(local, access, &listings, remote)? {
        remove_deleted(local, access, doomed, report)?;
    }

    let held = held_back_docs(local, access)?;
    let mut docs: BTreeSet<Uuid> = remote.keys().copied().collect();

    docs.extend(local.with(|store| store.ids(access.space))?);
    docs.retain(|id| {
        !listings.contains(id)
            && !tombstones.contains(id)
            && !held.contains(id)
            && !orphans.contains(id)
    });

    sync_docs(local, &mut link, &docs, remote, &outbox, report).await
}

async fn sync_some(
    local: &impl Local,
    access: &Access,
    remote: &BTreeMap<Uuid, i64>,
    stuck: &BTreeSet<Uuid>,
    gone: &BTreeSet<Uuid>,
    report: &mut Report,
) -> Result<(), Error> {
    let mut link = Link::open(local, access)?;
    let outbox = outbox_docs(local, access)?;
    let held = held_back_docs(local, access)?;
    let orphans = orphans_of(local, access, gone.iter().copied())?;
    let mut docs: BTreeSet<Uuid> = remote.keys().copied().collect();

    docs.extend(outbox.iter().filter(|id| !stuck.contains(id)).copied());
    docs.retain(|id| !held.contains(id) && !gone.contains(id) && !orphans.contains(id));
    let listings = wanted_listings(local, access, |id| docs.contains(id))?;

    docs.retain(|id| !listings.contains(id));
    let revived = sync_listings(local, &mut link, &listings, remote, &outbox, report).await?;

    if listings_current(local, access, &listings, remote)? {
        remove_deleted(local, access, gone.iter().copied().collect(), report)?;
    }

    for id in revived {
        exchange_doc(local, &mut link, id, report).await?;
    }

    sync_docs(local, &mut link, &docs, remote, &outbox, report).await
}
