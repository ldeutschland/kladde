use crate::{Error, Note, Store, history, listing, private_state::SET_STATE, search, uuid_col};
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

impl Store {
    pub fn save(&mut self, notes: &[Note], remote: bool) -> Result<(), Error> {
        if notes.len() > 1000 {
            return Err(Error::Invalid);
        }

        self.save_with(notes, remote, None)
    }

    pub fn restore(&mut self, notes: &[Note]) -> Result<(), Error> {
        self.save_with(notes, false, None)
    }

    pub(crate) fn save_with(
        &mut self,
        notes: &[Note],
        remote: bool,
        checkpoint: Option<(&str, &[u8])>,
    ) -> Result<(), Error> {
        if notes.is_empty() || notes.len() > MAX_SAVED_NOTES {
            return Err(Error::Invalid);
        }

        let now = history::now();
        let tx = self.0.savepoint()?;

        for note in notes {
            save_note(&tx, note, now, remote)?;
        }

        if let Some((id, value)) = checkpoint {
            tx.execute(SET_STATE, params![id, value])?;
        }

        tx.commit()?;

        Ok(())
    }

    pub fn ids(&self, space: Uuid) -> Result<Vec<Uuid>, Error> {
        Ok(self
            .0
            .prepare("SELECT id FROM notes WHERE space=?1 ORDER BY rowid")?
            .query_map([space.to_string()], |r| uuid_col(r, 0))?
            .collect::<Result<_, _>>()?)
    }

    pub(crate) fn read_note(db: &Connection, id: Uuid) -> Result<Option<Note>, Error> {
        let mut note=db.query_row("SELECT space,kind,title,body,parent,archived,props,data,rev FROM notes WHERE id=?1",[id.to_string()],|r|Ok(Note{id,space:uuid_col(r,0)?,kind:r.get(1)?,title:r.get(2)?,body:r.get(3)?,parent:r.get::<_,Option<String>>(4)?.map(|s|s.parse()).transpose().map_err(|_|rusqlite::Error::InvalidQuery)?,archived:r.get(5)?,props:r.get(6)?,data:r.get(7)?,rev:r.get(8)?,links:vec![]})).optional()?;

        if let Some(n) = &mut note {
            n.links = db
                .prepare("SELECT target FROM backlinks WHERE source=?1")?
                .query_map([id.to_string()], |r| uuid_col(r, 0))?
                .collect::<Result<_, _>>()?
        }

        Ok(note)
    }

    pub fn get(&self, id: Uuid) -> Result<Option<Note>, Error> {
        Self::read_note(&self.0, id)
    }

    pub fn revision(&self, id: Uuid) -> Result<Option<(Uuid, String, i64)>, Error> {
        Ok(self
            .0
            .query_row(
                "SELECT space,kind,rev FROM notes WHERE id=?1",
                [id.to_string()],
                |r| Ok((uuid_col(r, 0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?)
    }

    pub fn spaces(&self) -> Result<Vec<(Uuid, String)>, Error> {
        Ok(self
            .0
            .prepare("SELECT id,title FROM notes WHERE kind='workspace' ORDER BY rowid")?
            .query_map([], |r| Ok((uuid_col(r, 0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?)
    }

    pub fn backlinks(&self, id: Uuid) -> Result<Vec<Uuid>, Error> {
        Ok(self.0.prepare("SELECT source FROM backlinks JOIN notes ON source=id WHERE target=?1 AND archived=0")?.query_map([id.to_string()],|r|uuid_col(r,0))?.collect::<Result<_,_>>()?)
    }
}

const MAX_SAVED_NOTES: usize = 50000;
const MAX_TITLE_BYTES: usize = 2048;
const MAX_BODY_BYTES: usize = 2_000_000;
const MAX_DATA_BYTES: usize = 4_194_304;
const MAX_PROPS_BYTES: usize = 262144;
pub(crate) const MAX_LINKS: usize = 4096;

fn save_note(tx: &Connection, note: &Note, now: i64, remote: bool) -> Result<(), Error> {
    refuse_deleted(tx, note.id)?;
    check_note(note)?;
    let id = note.id.to_string();
    let old = Store::read_note(tx, note.id)?;

    if old.as_ref().map_or(0, |stored| stored.rev) != note.rev
        || old
            .as_ref()
            .is_some_and(|stored| stored.space != note.space || stored.kind != note.kind)
    {
        return Err(Error::Conflict);
    }

    if let Some(previous) = old {
        history::capture(tx, &previous, note, now, remote)?;
    }

    let rev = note.rev + 1;

    write_note(tx, note, &id, rev, now)?;

    if !remote {
        tx.execute(
            "INSERT INTO outbox VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET rev=excluded.rev",
            params![id, rev],
        )?;
    }

    Ok(())
}

fn refuse_deleted(tx: &Connection, id: Uuid) -> Result<(), Error> {
    if tx.query_row(
        "SELECT exists(SELECT 1 FROM deletions WHERE id=?1)",
        [id.to_string()],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(Error::Conflict);
    }

    Ok(())
}

fn check_note(note: &Note) -> Result<(), Error> {
    if note.id.get_version_num() != 4
        || note.space.get_version_num() != 4
        || note.rev < 0
        || note.rev == i64::MAX
        || note.title.len() > MAX_TITLE_BYTES
        || note.body.len() > MAX_BODY_BYTES
        || note.data.is_empty()
        || note.data.len() > MAX_DATA_BYTES
        || note.props.len() > MAX_PROPS_BYTES
        || note.links.len() > MAX_LINKS
        || note.parent == Some(note.id)
        || !matches!(
            note.kind.as_str(),
            "workspace" | "page" | "row" | "database" | "chat" | "index"
        )
        || (note.kind == "workspace") != (note.id == note.space)
    {
        return Err(Error::Invalid);
    }

    let props: serde_json::Value = serde_json::from_str(&note.props).map_err(|_| Error::Invalid)?;

    if !props.is_object()
        || note.links.iter().any(|id| id.get_version_num() != 4)
        || note.parent.is_some_and(|id| id.get_version_num() != 4)
    {
        return Err(Error::Invalid);
    }

    Ok(())
}

fn write_note(tx: &Connection, note: &Note, id: &str, rev: i64, now: i64) -> Result<(), Error> {
    let space = note.space.to_string();

    tx.execute("INSERT INTO notes VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO UPDATE SET title=excluded.title,body=excluded.body,parent=excluded.parent,archived=excluded.archived,props=excluded.props,data=excluded.data,rev=excluded.rev",params![id,space,note.kind,note.title,note.body,note.parent.map(|v|v.to_string()),note.archived,note.props,note.data,rev])?;
    history::mark_saved(tx, id, now)?;
    search::refresh_files(tx, note)?;
    listing::refresh(tx, note)?;
    listing::mark_row(tx, note)?;
    search::index_words(tx, id)?;

    replace_backlinks(tx, id, &note.links)
}

fn replace_backlinks(tx: &Connection, id: &str, links: &[Uuid]) -> Result<(), Error> {
    tx.execute("DELETE FROM backlinks WHERE source=?1", [id])?;

    for link in links {
        tx.execute(
            "INSERT OR IGNORE INTO backlinks VALUES(?1,?2)",
            params![id, link.to_string()],
        )?;
    }

    Ok(())
}
