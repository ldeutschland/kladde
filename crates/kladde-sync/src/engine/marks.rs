use super::Local;
use super::report::Report;
use crate::{Error, account::Access};
use kladde_protocol::{self as p, account::SpaceState};

pub(super) fn mark_key(access: &Access) -> String {
    format!("relay:{}:{}:mark", access.account, access.space)
}

pub(super) fn known_mark(local: &impl Local, access: &Access) -> Result<i64, Error> {
    let Some(bytes) = local.with(|store| store.state(&mark_key(access)))? else {
        return Ok(0);
    };

    let (mark, epoch): (i64, u32) = p::decode(&bytes)?;

    Ok(if epoch == access.epoch() { mark } else { 0 })
}

pub(super) fn remember_mark(
    local: &impl Local,
    access: &Access,
    state: &SpaceState,
    report: &Report,
) -> Result<(), Error> {
    let Some(mark) = state.mark else {
        return Ok(());
    };

    if report.stopped.is_some() || !report.failed.is_empty() {
        return Ok(());
    }

    let bytes = p::encode(&(mark, access.epoch()))?;

    local.with(|store| store.set_state(&mark_key(access), &bytes))
}

pub(super) fn has_mark(local: &impl Local, access: &Access) -> Result<bool, Error> {
    Ok(local
        .with(|store| store.state(&mark_key(access)))?
        .is_some())
}
