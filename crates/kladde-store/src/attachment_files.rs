use crate::{Error, Store, private_state::SET_STATE, uuid_col};
use rusqlite::params;
use uuid::Uuid;

const TEXT_BLOB_FILES: &str = "INSERT OR IGNORE INTO erased_files SELECT ?4,space FROM erased_texts WHERE doc=?1 AND file=?2 AND space=?3";
const TEXT_BLOB_DOCS: &str = "INSERT OR IGNORE INTO erased_file_docs SELECT ?4,owner FROM erased_texts WHERE doc=?1 AND file=?2 AND space=?3";
const ORPHAN_OWNER: &str = "INSERT OR IGNORE INTO erased_file_docs SELECT ?1,COALESCE((SELECT owner FROM discards WHERE id=?2),?2)";

impl Store {
    pub fn store_asset(
        &mut self,
        space: Uuid,
        doc: Uuid,
        id: Uuid,
        bytes: &[u8],
    ) -> Result<(), Error> {
        if bytes.len() > kladde_protocol::MAX_ENCODED_ATTACHMENT {
            return Err(Error::Invalid);
        }

        let tx = self.0.savepoint()?;

        if !tx.query_row(
            "SELECT exists(SELECT 1 FROM notes WHERE id=?1 AND space=?2)",
            params![doc.to_string(), space.to_string()],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(Error::Invalid);
        }

        if tx.execute(
            "INSERT INTO file_owners VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc WHERE file_owners.doc=excluded.doc AND file_owners.space=excluded.space",
            params![id.to_string(), doc.to_string(), space.to_string()],
        )? != 1 {
            return Err(Error::Conflict);
        }

        tx.execute(
            "UPDATE page_files SET retry_at=0 WHERE doc=?1 AND file=?2 AND status='pending'",
            params![doc.to_string(), id.to_string()],
        )?;
        tx.execute(SET_STATE, params![format!("asset:{space}:{id}"), bytes])?;
        tx.commit()?;

        Ok(())
    }

    pub fn erased_files(&self, space: Uuid) -> Result<Vec<Uuid>, Error> {
        Ok(self
            .0
            .prepare("SELECT e.id FROM erased_files e LEFT JOIN erased_file_docs o ON o.file=e.id WHERE e.space=?1 AND NOT EXISTS(SELECT 1 FROM deletions d WHERE d.id=o.doc AND d.confirmed=0)")?
            .query_map([space.to_string()], |r| uuid_col(r, 0))?
            .collect::<Result<_, _>>()?)
    }

    pub fn file_erased(&self, space: Uuid, id: Uuid) -> Result<(), Error> {
        self.0.execute(
            "DELETE FROM erased_files WHERE id=?1 AND space=?2",
            params![id.to_string(), space.to_string()],
        )?;
        self.0.execute(
            "DELETE FROM erased_file_docs WHERE file=?1",
            [id.to_string()],
        )?;

        Ok(())
    }

    pub fn erased_texts(&self, space: Uuid) -> Result<Vec<(Uuid, Uuid)>, Error> {
        Ok(self
            .0
            .prepare("SELECT doc,file FROM erased_texts WHERE space=?1")?
            .query_map([space.to_string()], |r| {
                Ok((uuid_col(r, 0)?, uuid_col(r, 1)?))
            })?
            .collect::<Result<_, _>>()?)
    }

    pub fn erase_text_blobs(
        &mut self,
        space: Uuid,
        blobs: &[(Uuid, Uuid, Uuid)],
    ) -> Result<(), Error> {
        let tx = self.0.transaction()?;
        let space = space.to_string();

        for (doc, file, blob) in blobs {
            let (doc, file, blob) = (doc.to_string(), file.to_string(), blob.to_string());

            tx.execute(TEXT_BLOB_FILES, params![doc, file, space, blob])?;
            tx.execute(TEXT_BLOB_DOCS, params![doc, file, space, blob])?;
            tx.execute(
                "DELETE FROM erased_texts WHERE doc=?1 AND file=?2 AND space=?3",
                params![doc, file, space],
            )?;
        }

        tx.commit()?;

        Ok(())
    }

    pub fn erase_if_orphaned(&mut self, space: Uuid, doc: Uuid, blob: Uuid) -> Result<bool, Error> {
        let tx = self.0.transaction()?;
        let (space, doc, blob) = (space.to_string(), doc.to_string(), blob.to_string());
        let kept: bool = tx.query_row(
            "SELECT exists(SELECT 1 FROM notes WHERE id=?1 AND space=?2)",
            params![doc, space],
            |r| r.get(0),
        )?;

        if kept {
            return Ok(false);
        }

        tx.execute(
            "INSERT OR IGNORE INTO erased_files VALUES(?1,?2)",
            params![blob, space],
        )?;
        tx.execute(ORPHAN_OWNER, params![blob, doc])?;
        tx.commit()?;

        Ok(true)
    }
}
