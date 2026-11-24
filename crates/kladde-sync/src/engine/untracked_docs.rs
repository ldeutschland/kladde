use super::Local;
use super::doc_state_keys::head_prefix;
use crate::{Error, account::Access};
use std::collections::BTreeSet;
use uuid::Uuid;

fn untracked_docs(local: &impl Local, access: &Access) -> Result<Vec<Uuid>, Error> {
    local.with(|store| store.untracked(access.space, &head_prefix(access)))
}

pub(super) fn has_untracked_docs(local: &impl Local, access: &Access) -> Result<bool, Error> {
    Ok(!untracked_docs(local, access)?.is_empty())
}

pub(super) fn queue_untracked_docs(
    local: &impl Local,
    access: &Access,
    tombstones: &BTreeSet<Uuid>,
) -> Result<(), Error> {
    let mut untracked = untracked_docs(local, access)?;

    untracked.retain(|id| !tombstones.contains(id));

    if untracked.is_empty() {
        return Ok(());
    }

    local.with(|store| store.queue(&untracked))
}
