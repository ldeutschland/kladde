mod archive;
mod attachment_files;
mod backup;
mod database_rows;
mod deletions;
mod history;
mod listing;
mod merge;
mod notes;
mod opening;
mod outbox;
mod part_hashes;
mod parts;
mod private_state;
mod readable;
mod search;
mod shared_versions;
mod space_deletion;

pub use archive::Archive;
pub use backup::{Bundle, Record};
pub use database_rows::{ROW_PAGE, RowChange, RowRecord};
pub use history::Version;
pub use merge::{Incoming, wire_form};
pub use part_hashes::{Hash, Listing};
pub use parts::MAX_FILE_PARTS;
pub use search::{Attachment, AttachmentJob, ExtractedText, Passage, SearchHit};
pub use shared_versions::{SharedVersion, Shares};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub const MAX_BACKUP_BYTES: usize = 96 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum Error {
    #[error("Invalid notebook data")]
    Invalid,
    #[error("Notebook was modified")]
    Conflict,
    #[error("Encrypted storage is unavailable")]
    Storage(#[from] rusqlite::Error),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Note {
    pub id: Uuid,
    pub space: Uuid,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub parent: Option<Uuid>,
    pub archived: bool,
    pub props: String,
    pub links: Vec<Uuid>,
    pub data: Vec<u8>,
    pub rev: i64,
}

pub struct Store(Connection);

fn uuid_col(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<Uuid> {
    row.get::<_, String>(column)?
        .parse()
        .map_err(|_| rusqlite::Error::InvalidQuery)
}
