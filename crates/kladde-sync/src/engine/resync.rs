use super::Local;
use super::doc_state_keys::{DocKeys, head_prefix, read_cursor};
use super::marks::mark_key;
use crate::{Cursor, Error, account::Access};
use kladde_protocol as p;
use kladde_store::Store;

fn restarted(store: &Store, head: &str) -> Result<Vec<u8>, kladde_store::Error> {
    let floor = Cursor {
        epoch: read_cursor(store, head)?.epoch,
        ..Cursor::default()
    };

    p::encode(&floor).map_err(|_| kladde_store::Error::Invalid)
}

pub fn resync(local: &impl Local, access: &Access) -> Result<(), Error> {
    local.with(|store| {
        let heads = store.state_keys(&head_prefix(access))?;
        let restarts = heads
            .iter()
            .map(|head| Ok((head.clone(), restarted(store, head)?)))
            .collect::<Result<Vec<_>, kladde_store::Error>>()?;
        let ids = store.ids(access.space)?;
        let mut stale: Vec<String> = ids
            .iter()
            .map(|id| DocKeys::new(access, *id).pending)
            .collect();

        stale.push(mark_key(access));
        let set: Vec<(String, &[u8])> = restarts
            .iter()
            .map(|(head, bytes)| (head.clone(), bytes.as_slice()))
            .collect();
        let cleared: Vec<&str> = stale.iter().map(String::as_str).collect();

        store.queue(&ids)?;
        store.replace_states(&set, &cleared)
    })
}
