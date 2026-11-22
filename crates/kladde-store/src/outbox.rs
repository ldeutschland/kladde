use crate::{Error, Note, Store, uuid_col};
use rusqlite::{OptionalExtension, params};
use uuid::Uuid;

impl Store {
    pub fn outbox(&self, space: Uuid) -> Result<Vec<Uuid>, Error> {
        Ok(self
            .0
            .prepare("SELECT notes.id FROM outbox JOIN notes ON notes.id=outbox.id WHERE space=?1")?
            .query_map([space.to_string()], |r| uuid_col(r, 0))?
            .collect::<Result<_, _>>()?)
    }

    pub fn queued(&self, id: Uuid) -> Result<Option<(Note, i64)>, Error> {
        let rev = self
            .0
            .query_row(
                "SELECT rev FROM outbox WHERE id=?1",
                [id.to_string()],
                |r| r.get(0),
            )
            .optional()?;
        let Some(rev) = rev else {
            return Ok(None);
        };

        Ok(self.get(id)?.map(|note| (note, rev)))
    }

    pub fn pending(&self, space: Uuid) -> Result<Vec<(Uuid, i64)>, Error> {
        Ok(self.0.prepare("SELECT notes.id,outbox.rev FROM outbox JOIN notes ON notes.id=outbox.id WHERE space=?1 ORDER BY outbox.rowid LIMIT 100")?.query_map([space.to_string()],|r|Ok((uuid_col(r,0)?,r.get(1)?)))?.collect::<Result<_,_>>()?)
    }

    pub fn acknowledge(&self, space: Uuid, id: Uuid, rev: i64) -> Result<(), Error> {
        self.0.execute(
            "DELETE FROM outbox WHERE id=?1 AND rev=?2 AND id IN (SELECT id FROM notes WHERE id=?1 AND space=?3)",
            params![id.to_string(), rev, space.to_string()],
        )?;

        Ok(())
    }
}
