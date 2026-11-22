use crate::{Error, Store};
use rusqlite::{OptionalExtension, params};

pub(crate) const SET_STATE: &str =
    "INSERT INTO private_state VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET value=excluded.value";

pub(crate) const CLEAR_STATE: &str = "DELETE FROM private_state WHERE id=?1";

impl Store {
    pub fn state(&self, id: &str) -> Result<Option<Vec<u8>>, Error> {
        Ok(self
            .0
            .query_row("SELECT value FROM private_state WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_state(&self, id: &str, value: &[u8]) -> Result<(), Error> {
        self.0.execute(SET_STATE, params![id, value])?;

        Ok(())
    }

    pub fn state_keys(&self, prefix: &str) -> Result<Vec<String>, Error> {
        Ok(self
            .0
            .prepare("SELECT id FROM private_state WHERE substr(id,1,length(?1))=?1")?
            .query_map([prefix], |r| r.get(0))?
            .collect::<Result<_, _>>()?)
    }

    pub fn clear_state(&self, key: &str) -> Result<(), Error> {
        self.0.execute(CLEAR_STATE, [key])?;

        Ok(())
    }

    pub fn replace_states(
        &mut self,
        set: &[(String, &[u8])],
        cleared: &[&str],
    ) -> Result<(), Error> {
        let tx = self.0.transaction()?;

        for (id, value) in set {
            tx.execute(SET_STATE, params![id, value])?;
        }

        for id in cleared {
            tx.execute(CLEAR_STATE, [id])?;
        }

        tx.commit()?;

        Ok(())
    }
}
