use crate::{Cursor, account::Access};
use kladde_store::Store;
use uuid::Uuid;

pub(super) fn read_cursor(store: &Store, key: &str) -> Result<Cursor, kladde_store::Error> {
    match store.state(key)? {
        None => Ok(Cursor::default()),
        Some(b) => Cursor::decode(&b).map_err(|_| kladde_store::Error::Invalid),
    }
}

pub(super) fn head_prefix(access: &Access) -> String {
    format!("head:{}:{}:", access.account, access.space)
}

pub(super) struct DocKeys {
    pub(super) id: Uuid,
    pub(super) head: String,
    pub(super) pending: String,
}

impl DocKeys {
    pub(super) fn new(access: &Access, id: Uuid) -> Self {
        Self {
            id,
            head: format!("{}{id}", head_prefix(access)),
            pending: format!("wire:{}:{id}", access.account),
        }
    }
}
