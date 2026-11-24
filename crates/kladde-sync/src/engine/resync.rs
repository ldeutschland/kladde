use super::Local;
use super::doc_state_keys::{DocKeys, head_prefix};
use super::marks::mark_key;
use crate::{Error, account::Access};

pub fn resync(local: &impl Local, access: &Access) -> Result<(), Error> {
    local.with(|store| {
        let mut stale = store.state_keys(&head_prefix(access))?;
        let pending = store.ids(access.space)?.into_iter();

        stale.extend(pending.map(|id| DocKeys::new(access, id).pending));
        stale.push(mark_key(access));
        let cleared: Vec<&str> = stale.iter().map(String::as_str).collect();

        store.replace_states(&[], &cleared)
    })
}
