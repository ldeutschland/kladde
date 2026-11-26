use super::Local;
use super::doc_state_keys::DocKeys;
use super::report::Report;
use crate::{Error, account::Access};
use ed25519_dalek::{Signature, VerifyingKey};
use kladde_crypto as c;
use kladde_protocol::{
    Certificate,
    account::{SpaceState, Tombstone, purge_message},
};

use kladde_store::Store;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub(super) fn tombstoned_docs(
    local: &impl Local,
    access: &Access,
    tombstones: &BTreeSet<Uuid>,
) -> Result<Vec<Uuid>, Error> {
    let mut ids = local.with(|store| store.ids(access.space))?;

    ids.retain(|id| tombstones.contains(id));

    Ok(ids)
}

pub(super) fn signed_among(access: &Access, state: &SpaceState, ids: &[Uuid]) -> Vec<Uuid> {
    let candidates: BTreeSet<Uuid> = ids.iter().copied().collect();
    let signers = signer_keys(access, &state.signers);
    let signed: BTreeSet<Uuid> = state
        .tombstones
        .iter()
        .filter(|tombstone| candidates.contains(&tombstone.doc))
        .filter(|tombstone| {
            signers
                .get(&tombstone.device)
                .is_some_and(|key| proves_removal(access, key, tombstone))
        })
        .map(|tombstone| tombstone.doc)
        .collect();

    ids.iter()
        .copied()
        .filter(|id| signed.contains(id))
        .collect()
}

fn signer_keys(access: &Access, signers: &[Certificate]) -> BTreeMap<Uuid, VerifyingKey> {
    let Ok(identity) = VerifyingKey::from_bytes(&access.identity) else {
        return BTreeMap::new();
    };

    signers
        .iter()
        .filter_map(|cert| {
            let key = c::device_key(&identity, access.account, cert).ok()?;

            Some((cert.device, key))
        })
        .collect()
}

fn proves_removal(access: &Access, key: &VerifyingKey, tombstone: &Tombstone) -> bool {
    let Ok(message) = purge_message(access.account, access.space, tombstone.doc) else {
        return false;
    };

    Signature::from_slice(&tombstone.proof)
        .is_ok_and(|signature| key.verify_strict(&message, &signature).is_ok())
}

pub(super) fn orphans_of(
    local: &impl Local,
    access: &Access,
    deleted: impl IntoIterator<Item = Uuid>,
) -> Result<BTreeSet<Uuid>, Error> {
    let mut orphans = BTreeSet::new();

    for owner in deleted {
        orphans.extend(local.with(|store| store.owned_by(access.space, owner))?);
    }

    Ok(orphans)
}

pub(super) fn remove_deleted(
    local: &impl Local,
    access: &Access,
    doomed: Vec<Uuid>,
    report: &mut Report,
) -> Result<(), Error> {
    if doomed.is_empty() || local.with(|store| store.revision(access.space))?.is_none() {
        return Ok(());
    }

    for id in doomed {
        match local.with(|store| drop_unless_unsent(store, access, id))? {
            Fate::Rescued => report.rescue.push(id),
            Fate::Removed => report.removed.push(id),
            Fate::Untouched => {}
        }
    }

    Ok(())
}

enum Fate {
    Untouched,
    Rescued,
    Removed,
}

fn drop_unless_unsent(
    store: &mut Store,
    access: &Access,
    id: Uuid,
) -> Result<Fate, kladde_store::Error> {
    let owner = store.revision(id)?.map(|(owner, ..)| owner);

    if id == access.space || owner != Some(access.space) || store.is_registered(access.space, id)? {
        return Ok(Fate::Untouched);
    }

    let keys = DocKeys::new(access, id);

    if has_unsent_changes(store, access, &keys)? {
        store.set_state(&rescue_key(access, id), &[1])?;

        return Ok(Fate::Rescued);
    }

    let removed = store.drop_synced(access.space, id)?;

    store.clear_state(&keys.head)?;
    store.clear_state(&keys.pending)?;
    store.clear_state(&rescue_key(access, id))?;

    Ok(if removed {
        Fate::Removed
    } else {
        Fate::Untouched
    })
}

fn has_unsent_changes(
    store: &Store,
    access: &Access,
    keys: &DocKeys,
) -> Result<bool, kladde_store::Error> {
    Ok(store.queued(keys.id)?.is_some()
        || store.state(&keys.pending)?.is_some()
        || store.rows_waiting(keys.id)?
        || store.is_listed(access.space, keys.id)?)
}

fn rescue_key(access: &Access, id: Uuid) -> String {
    format!("rescue:{}:{}:{id}", access.account, access.space)
}

pub fn discard_rescued(local: &impl Local, access: &Access, id: Uuid) -> Result<(), Error> {
    let rescue = rescue_key(access, id);
    let keys = DocKeys::new(access, id);

    local.with(|store| {
        if store.state(&rescue)?.is_none() {
            return Err(kladde_store::Error::Invalid);
        }

        store.drop_synced(access.space, id)?;
        store.clear_state(&keys.head)?;
        store.clear_state(&keys.pending)?;

        store.clear_state(&rescue)
    })
}
