pub mod account_setup;
pub mod devices;
pub mod document_sync;
pub mod error_messages;
pub mod live_watch;
pub mod session;
pub mod shared_versions;
pub mod stored_account;
pub mod workspaces;

use kladde_crypto::Key;
use std::{
    collections::{BTreeSet, HashMap},
    sync::Mutex,
};

use uuid::Uuid;

#[derive(Default)]
pub struct SyncState {
    phrase: Mutex<Option<(Key, usize, usize)>>,
    lock: tokio::sync::Mutex<()>,
    stuck: Mutex<HashMap<Uuid, BTreeSet<Uuid>>>,
}

impl SyncState {
    fn stuck_in(&self, space: Uuid) -> BTreeSet<Uuid> {
        let known = self.stuck.lock().ok();

        known
            .and_then(|spaces| spaces.get(&space).cloned())
            .unwrap_or_default()
    }

    fn remember_stuck(&self, space: Uuid, failed: &[Uuid]) {
        if let Ok(mut spaces) = self.stuck.lock() {
            spaces.insert(space, failed.iter().copied().collect());
        }
    }
}
