mod batches;
mod deletions;
mod doc_exchange;
mod doc_state_keys;
mod listings;
mod marks;
mod pending_pushes;
mod relay_features;
mod relay_link;
mod relay_requests;
mod remote_removals;
mod report;
mod resync;
mod space_state;
mod space_sync;
mod untracked_docs;

#[cfg(test)]
mod tests;

pub use deletions::erase_blob;
pub use relay_features::{Relay, handshake};
pub use relay_requests::{call, require_success};
pub use remote_removals::discard_rescued;
pub use report::{Report, error_code};
pub use resync::resync;
pub use space_state::{remote_blobs, remote_state};
pub use space_sync::{sync_changes, sync_changes_except, sync_latest, sync_space};

use crate::Error;
use kladde_store::Store;
use uuid::Uuid;

pub const UNKNOWN_SEQ: i64 = -1;

pub trait Local {
    fn with<T>(
        &self,
        work: impl FnOnce(&mut Store) -> Result<T, kladde_store::Error>,
    ) -> Result<T, Error>;

    fn changed(&self, _id: Uuid) {}
}

pub fn local_error(error: kladde_store::Error) -> Error {
    match error {
        kladde_store::Error::Storage(_) => Error::Storage,
        _ => Error::Conflict,
    }
}
