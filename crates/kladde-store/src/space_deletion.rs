use crate::{Error, Store};
use rusqlite::params;
use uuid::Uuid;

const SPACE_STATE: &str =
    "DELETE FROM private_state WHERE substr(id,1,length(?2))=?2 AND instr(id,':'||?1||':')>0";
const SPACE_STATE_KINDS: [&str; 6] = [
    "asset:",
    "head:",
    "relay:",
    "rescue:",
    "uploaded:",
    "shared-text:",
];

const PURGE_SPACE: [&str; 15] = [
    "DELETE FROM file_words WHERE rowid IN (SELECT f.rowid FROM page_files f JOIN notes n ON n.id=f.doc WHERE n.space=?1)",
    "DELETE FROM private_state WHERE substr(id,1,5)='wire:' AND substr(id,-36) IN (SELECT id FROM notes WHERE space=?1)",
    "DELETE FROM private_state WHERE id='restore:'||?1",
    "DELETE FROM row_marks WHERE id IN (SELECT id FROM notes WHERE space=?1) OR parent IN (SELECT id FROM notes WHERE space=?1)",
    "DELETE FROM erased_file_docs WHERE file IN (SELECT id FROM erased_files WHERE space=?1) OR doc IN (SELECT id FROM notes WHERE space=?1)",
    "DELETE FROM erased_files WHERE space=?1",
    "DELETE FROM erased_texts WHERE space=?1",
    "DELETE FROM deletions WHERE space=?1",
    "DELETE FROM discards WHERE space=?1",
    "DELETE FROM file_owners WHERE space=?1",
    "DELETE FROM page_artwork WHERE space=?1",
    "DELETE FROM words WHERE space=?1",
    "DELETE FROM listing WHERE space=?1",
    "DELETE FROM backlinks WHERE target IN (SELECT id FROM notes WHERE space=?1)",
    "DELETE FROM notes WHERE space=?1",
];

impl Store {
    pub fn has_unsynced_changes(&self, space: Uuid) -> Result<bool, Error> {
        Ok(!self.outbox(space)?.is_empty() || !self.deletions(space)?.is_empty())
    }

    pub fn delete_space(&mut self, space: Uuid) -> Result<(), Error> {
        let is_workspace = self
            .revision(space)?
            .is_some_and(|(owner, kind, _)| owner == space && kind == "workspace");

        if !is_workspace {
            return Err(Error::Invalid);
        }

        let tx = self.0.transaction()?;
        let space = space.to_string();

        for kind in SPACE_STATE_KINDS {
            tx.execute(SPACE_STATE, params![space, kind])?;
        }

        for statement in PURGE_SPACE {
            tx.execute(statement, [&space])?;
        }

        tx.commit()?;

        Ok(())
    }
}
