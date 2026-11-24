use crate::{Error, Store, listing, uuid_col};
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

const DISCARD_BATCH: i64 = 2000;
const CHILDREN_LEFT: &str = "SELECT exists(SELECT 1 FROM notes c JOIN notes p ON p.id=c.parent WHERE c.parent=?1 AND c.kind!='index' AND NOT (c.kind='row' AND p.kind='database'))";

const DISCARD_ROWS: [&str; 3] = [
    "INSERT OR IGNORE INTO erased_files SELECT f.id,f.space FROM file_owners f JOIN notes n ON n.id=f.doc WHERE n.parent=?1 AND n.kind='row'",
    "INSERT OR IGNORE INTO erased_file_docs SELECT f.id,?1 FROM file_owners f JOIN notes n ON n.id=f.doc WHERE n.parent=?1 AND n.kind='row'",
    "INSERT OR IGNORE INTO discards SELECT id,space,?1 FROM notes WHERE parent=?1 AND kind IN ('row','index')",
];

const REMOVE_ROWS: [&str; 9] = [
    "DELETE FROM row_marks WHERE parent=?1",
    "DELETE FROM file_words WHERE rowid IN (SELECT f.rowid FROM page_files f JOIN notes n ON n.id=f.doc WHERE n.parent=?1 AND n.kind='row')",
    "DELETE FROM private_state WHERE id IN (SELECT 'asset:' || f.space || ':' || f.id FROM file_owners f JOIN notes n ON n.id=f.doc WHERE n.parent=?1 AND n.kind='row')",
    "DELETE FROM private_state WHERE substr(id,1,5) IN ('head:','wire:') AND substr(id,-36) IN (SELECT id FROM notes WHERE parent=?1 AND kind IN ('row','index'))",
    "DELETE FROM file_owners WHERE doc IN (SELECT id FROM notes WHERE parent=?1 AND kind='row')",
    "DELETE FROM page_artwork WHERE doc IN (SELECT id FROM notes WHERE parent=?1 AND kind='row')",
    "DELETE FROM words WHERE id IN (SELECT id FROM notes WHERE parent=?1 AND kind='row')",
    "DELETE FROM listing WHERE shard IN (SELECT id FROM notes WHERE parent=?1 AND kind='index')",
    "DELETE FROM notes WHERE parent=?1 AND kind IN ('row','index')",
];

impl Store {
    fn erasable(&self, id: Uuid) -> Result<Option<(Uuid, String)>, Error> {
        let Some((space, kind, _)) = self.revision(id)? else {
            return Ok(None);
        };

        if kind == "workspace" {
            return Ok(None);
        }

        let archived: bool = self.0.query_row(
            "SELECT archived FROM notes WHERE id=?1",
            [id.to_string()],
            |r| r.get(0),
        )?;
        let unlisted = self.revision(space)?.is_some() && !self.is_listed(space, id)?;

        Ok((archived || unlisted).then_some((space, kind)))
    }

    pub fn forget(&mut self, id: Uuid) -> Result<(), Error> {
        let (space, kind) = self.erasable(id)?.ok_or(Error::Invalid)?;
        let tx = self.0.transaction()?;

        if tx.query_row(CHILDREN_LEFT, [id.to_string()], |r| r.get::<_, bool>(0))? {
            return Err(Error::Conflict);
        }

        tx.execute(
            "INSERT INTO deletions(space,id) VALUES(?1,?2)",
            params![space.to_string(), id.to_string()],
        )?;

        if kind == "database" {
            Self::discard_rows(&tx, id)?;
        }

        tx.execute(
            "INSERT OR IGNORE INTO erased_files SELECT id,space FROM file_owners WHERE doc=?1",
            [id.to_string()],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO erased_file_docs SELECT id,doc FROM file_owners WHERE doc=?1",
            [id.to_string()],
        )?;

        if Self::remove_note(&tx, id, space)? != 1 {
            return Err(Error::Invalid);
        }

        tx.commit()?;

        Ok(())
    }

    fn discard_rows(tx: &Connection, database: Uuid) -> Result<(), Error> {
        let database = database.to_string();

        for statement in DISCARD_ROWS {
            tx.execute(statement, [&database])?;
        }

        Self::remove_rows(tx, &database)
    }

    fn remove_rows(tx: &Connection, database: &str) -> Result<(), Error> {
        for statement in REMOVE_ROWS {
            tx.execute(statement, [database])?;
        }

        Ok(())
    }

    pub fn owned_by(&self, space: Uuid, owner: Uuid) -> Result<Vec<Uuid>, Error> {
        Ok(self
            .0
            .prepare(
                "SELECT id FROM notes WHERE space=?1 AND parent=?2 AND kind IN ('row','index')",
            )?
            .query_map(params![space.to_string(), owner.to_string()], |r| {
                uuid_col(r, 0)
            })?
            .collect::<Result<_, _>>()?)
    }

    pub fn rows_waiting(&self, database: Uuid) -> Result<bool, Error> {
        Ok(self.0.query_row(
            "SELECT exists(SELECT 1 FROM outbox JOIN notes ON notes.id=outbox.id WHERE parent=?1 AND kind='row')",
            [database.to_string()],
            |r| r.get(0),
        )?)
    }

    pub fn discards(&self, space: Uuid) -> Result<Option<(Uuid, Vec<Uuid>)>, Error> {
        let owner = self
            .0
            .query_row(
                "SELECT owner FROM discards d WHERE space=?1 AND NOT EXISTS(SELECT 1 FROM deletions x WHERE x.id=d.owner AND x.confirmed=0) LIMIT 1",
                [space.to_string()],
                |r| uuid_col(r, 0),
            )
            .optional()?;
        let Some(owner) = owner else {
            return Ok(None);
        };

        let ids = self
            .0
            .prepare("SELECT id FROM discards WHERE space=?1 AND owner=?2 LIMIT ?3")?
            .query_map(
                params![space.to_string(), owner.to_string(), DISCARD_BATCH],
                |r| uuid_col(r, 0),
            )?
            .collect::<Result<_, _>>()?;
        Ok(Some((owner, ids)))
    }

    pub fn discarding(&self, space: Uuid) -> Result<Vec<Uuid>, Error> {
        Ok(self
            .0
            .prepare("SELECT id FROM discards WHERE space=?1")?
            .query_map([space.to_string()], |r| uuid_col(r, 0))?
            .collect::<Result<_, _>>()?)
    }

    pub fn discarded(&mut self, ids: &[Uuid]) -> Result<(), Error> {
        let tx = self.0.transaction()?;

        for id in ids {
            tx.execute("DELETE FROM discards WHERE id=?1", [id.to_string()])?;
        }

        tx.commit()?;

        Ok(())
    }

    pub fn revive(&mut self, space: Uuid, id: Uuid) -> Result<(), Error> {
        let tx = self.0.transaction()?;
        let (space, id) = (space.to_string(), id.to_string());

        tx.execute(
            "DELETE FROM deletions WHERE id=?1 AND space=?2 AND confirmed=0",
            params![id, space],
        )?;
        tx.execute(
            "DELETE FROM erased_files WHERE space=?2 AND id IN (SELECT file FROM erased_file_docs WHERE doc=?1)",
            params![id, space],
        )?;
        tx.execute("DELETE FROM erased_file_docs WHERE doc=?1", [&id])?;
        tx.execute("DELETE FROM discards WHERE owner=?1", [&id])?;
        tx.commit()?;

        Ok(())
    }

    pub fn drop_synced(&mut self, space: Uuid, id: Uuid) -> Result<bool, Error> {
        if id == space {
            return Err(Error::Invalid);
        }

        let known = self.revision(id)?;

        if known.as_ref().is_some_and(|(owner, ..)| *owner != space) {
            return Ok(false);
        }

        let database = known.is_some_and(|(_, kind, _)| kind == "database");
        let tx = self.0.transaction()?;

        if database {
            Self::remove_rows(&tx, &id.to_string())?;
        }

        tx.execute(
            "INSERT INTO deletions(space,id,confirmed) VALUES(?1,?2,1) ON CONFLICT(id) DO UPDATE SET confirmed=1 WHERE deletions.space=excluded.space",
            params![space.to_string(), id.to_string()],
        )?;
        let removed = Self::remove_note(&tx, id, space)? == 1;

        tx.commit()?;

        Ok(removed)
    }

    fn remove_note(tx: &Connection, id: Uuid, space: Uuid) -> Result<usize, Error> {
        listing::mark_gone(tx, id)?;
        let id = id.to_string();

        tx.execute(
            "DELETE FROM file_words WHERE rowid IN (SELECT rowid FROM page_files WHERE doc=?1)",
            [&id],
        )?;
        let removed = tx.execute(
            "DELETE FROM notes WHERE id=?1 AND kind!='workspace' AND space=?2",
            params![id, space.to_string()],
        )?;

        if removed == 0 {
            return Ok(0);
        }

        tx.execute("DELETE FROM private_state WHERE id IN (SELECT 'asset:' || space || ':' || id FROM file_owners WHERE doc=?1)",[&id])?;
        tx.execute("DELETE FROM file_owners WHERE doc=?1", [&id])?;
        tx.execute("DELETE FROM page_artwork WHERE doc=?1", [&id])?;
        tx.execute("DELETE FROM words WHERE id=?1", [&id])?;
        tx.execute("DELETE FROM listing WHERE shard=?1", [&id])?;

        Ok(removed)
    }

    pub fn deletions(&self, space: Uuid) -> Result<Vec<Uuid>, Error> {
        Ok(self
            .0
            .prepare("SELECT id FROM deletions WHERE space=?1 AND confirmed=0")?
            .query_map([space.to_string()], |r| uuid_col(r, 0))?
            .collect::<Result<_, _>>()?)
    }

    pub fn deleted(&self, id: Uuid) -> Result<(), Error> {
        self.0.execute(
            "UPDATE deletions SET confirmed=1 WHERE id=?1",
            [id.to_string()],
        )?;

        Ok(())
    }
}
