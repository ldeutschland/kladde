use crate::{Error, Note, Store, parts, search, uuid_col};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;
use uuid::Uuid;
use yrs::{Any, Doc, Map, Out, Transact, Update};

pub(crate) type Placement = (Option<Uuid>, bool);

const REGISTRY: &str = "index";

#[derive(Clone, Copy, PartialEq)]
struct Entry {
    parent: Option<Uuid>,
    archived: Option<bool>,
    stamp: i64,
}

pub(crate) fn lists(kind: &str) -> bool {
    matches!(kind, "workspace" | "index")
}

pub(crate) fn refresh(db: &Connection, note: &Note) -> Result<(), Error> {
    if !lists(&note.kind) {
        return Ok(());
    }

    let current = entries_of(&note.data)?;
    let stored = stored_entries(db, note.id)?;
    let mut touched = Vec::new();

    for (id, entry) in &current {
        if stored.get(id) != Some(entry) {
            write(db, note, *id, entry)?;
            touched.push(*id);
        }
    }

    for id in stored.keys().filter(|id| !current.contains_key(id)) {
        db.execute(
            "DELETE FROM listing WHERE shard=?1 AND id=?2",
            params![note.id.to_string(), id.to_string()],
        )?;
        touched.push(*id);
    }

    touched
        .into_iter()
        .try_for_each(|id| settle(db, note.space, id))
}

pub(crate) fn mark_row(db: &Connection, note: &Note) -> Result<(), Error> {
    let Some(parent) = note.parent.filter(|_| note.kind == "row") else {
        return Ok(());
    };

    mark(db, note.id, parent, note.archived)
}

pub(crate) fn mark_gone(db: &Connection, id: Uuid) -> Result<(), Error> {
    let parent = db
        .query_row(
            "SELECT parent FROM notes WHERE id=?1 AND kind='row' AND parent IS NOT NULL",
            [id.to_string()],
            |r| uuid_col(r, 0),
        )
        .optional()?;
    match parent {
        Some(parent) => mark(db, id, parent, true),
        None => Ok(()),
    }
}

fn mark(db: &Connection, id: Uuid, parent: Uuid, gone: bool) -> Result<(), Error> {
    db.execute("UPDATE row_clock SET mark=mark+1", [])?;
    db.execute(
        "INSERT INTO row_marks VALUES(?1,?2,(SELECT mark FROM row_clock),?3) ON CONFLICT(id) DO UPDATE SET parent=excluded.parent,mark=excluded.mark,gone=excluded.gone",
        params![id.to_string(), parent.to_string(), gone],
    )?;

    Ok(())
}

pub(crate) fn rebuild(db: &Connection) -> Result<(), Error> {
    let shards = db
        .prepare("SELECT id FROM notes WHERE kind IN ('workspace','index')")?
        .query_map([], |r| uuid_col(r, 0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in shards {
        let note = crate::Store::read_note(db, id)?.ok_or(Error::Invalid)?;

        match refresh(db, &note) {
            Ok(()) | Err(Error::Invalid) => {}
            Err(error) => return Err(error),
        }
    }

    Ok(())
}

pub(crate) fn keys_of(data: &[u8]) -> Result<Vec<Uuid>, Error> {
    Ok(entries_of(data)?.into_keys().collect())
}

pub(crate) fn is_listed(db: &Connection, space: Uuid, id: Uuid) -> Result<bool, Error> {
    Ok(db.query_row(
        "SELECT exists(SELECT 1 FROM listing WHERE id=?1 AND space=?2)",
        params![id.to_string(), space.to_string()],
        |r| r.get(0),
    )?)
}

fn is_registered(db: &Connection, space: Uuid, id: Uuid) -> Result<bool, Error> {
    let mut registries =
        db.prepare("SELECT data FROM notes WHERE space=?1 AND kind IN ('workspace','index')")?;
    let datas = registries.query_map([space.to_string()], |r| r.get::<_, Vec<u8>>(0))?;

    for data in datas {
        if parts::listed_ids(&data?, REGISTRY)?.contains(&id) {
            return Ok(true);
        }
    }

    Ok(false)
}

pub(crate) fn listed_elsewhere(db: &Connection, shard: &Note, id: Uuid) -> Result<bool, Error> {
    Ok(db.query_row(
        "SELECT exists(SELECT 1 FROM listing WHERE id=?1 AND shard!=?2 AND space=?3)",
        params![
            id.to_string(),
            shard.id.to_string(),
            shard.space.to_string()
        ],
        |r| r.get(0),
    )?)
}

pub(crate) fn placed(db: &Connection, space: Uuid, id: Uuid) -> Result<Option<Placement>, Error> {
    let found = db
        .query_row(
            "SELECT parent,archived FROM listing WHERE id=?1 AND space=?2 AND archived IS NOT NULL ORDER BY stamp DESC,shard LIMIT 1",
            params![id.to_string(), space.to_string()],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, bool>(1)?)),
        )
        .optional()?;
    Ok(found.map(|(parent, archived)| {
        let parent = parent.and_then(|p| p.parse::<Uuid>().ok());

        (parent.filter(|p| *p != id), archived)
    }))
}

fn entries_of(data: &[u8]) -> Result<HashMap<Uuid, Entry>, Error> {
    let doc = Doc::new();
    let pages = doc.get_or_insert_map("pages");
    let update = Update::decode_complete_v1(data).map_err(|_| Error::Invalid)?;

    doc.transact_mut()
        .apply_update(update)
        .map_err(|_| Error::Invalid)?;
    let txn = doc.transact();

    Ok(pages
        .iter(&txn)
        .filter_map(|(key, value)| Some((key.parse().ok()?, entry_of(value))))
        .collect())
}

fn entry_of(value: Out) -> Entry {
    let Out::Any(Any::Map(page)) = value else {
        return Entry {
            parent: None,
            archived: None,
            stamp: 0,
        };
    };

    let parent = match page.get("parent") {
        Some(Any::String(id)) => id.parse::<Uuid>().ok(),
        _ => None,
    };

    let archived = match page.get("archived") {
        Some(Any::Number(at)) => at.as_i64() != Some(0),
        Some(Any::Bool(flag)) => *flag,
        _ => false,
    };

    let stamp = match page.get("updated") {
        Some(Any::Number(at)) => at.as_i64().unwrap_or(0),
        _ => 0,
    };

    Entry {
        parent: parent.filter(|id| id.get_version_num() == 4),
        archived: Some(archived),
        stamp,
    }
}

fn stored_entries(db: &Connection, shard: Uuid) -> Result<HashMap<Uuid, Entry>, Error> {
    let rows = db
        .prepare("SELECT id,parent,archived,stamp FROM listing WHERE shard=?1")?
        .query_map([shard.to_string()], |r| {
            let parent = r.get::<_, Option<String>>(1)?;
            let entry = Entry {
                parent: parent.and_then(|p| p.parse().ok()),
                archived: r.get(2)?,
                stamp: r.get(3)?,
            };

            Ok((uuid_col(r, 0)?, entry))
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

fn write(db: &Connection, note: &Note, id: Uuid, entry: &Entry) -> Result<(), Error> {
    db.execute(
        "INSERT INTO listing VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(shard,id) DO UPDATE SET parent=excluded.parent,archived=excluded.archived,stamp=excluded.stamp",
        params![
            note.id.to_string(),
            id.to_string(),
            note.space.to_string(),
            entry.parent.map(|p| p.to_string()),
            entry.archived,
            entry.stamp
        ],
    )?;

    Ok(())
}

fn settle(db: &Connection, space: Uuid, id: Uuid) -> Result<(), Error> {
    let Some(wanted) = placed(db, space, id)? else {
        return Ok(());
    };

    let current = db
        .query_row(
            "SELECT parent,archived,kind FROM notes WHERE id=?1 AND space=?2 AND kind NOT IN ('workspace','index')",
            params![id.to_string(), space.to_string()],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, bool>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((parent, archived, kind)) = current else {
        return Ok(());
    };

    if (parent.and_then(|p| p.parse::<Uuid>().ok()), archived) == wanted {
        return Ok(());
    }

    place(db, id, wanted)?;

    match wanted.0.filter(|_| kind == "row") {
        Some(parent) => mark(db, id, parent, wanted.1),
        None => Ok(()),
    }
}

fn place(db: &Connection, id: Uuid, (parent, archived): Placement) -> Result<(), Error> {
    let id = id.to_string();

    db.execute(
        "UPDATE notes SET parent=?2,archived=?3 WHERE id=?1",
        params![id, parent.map(|p| p.to_string()), archived],
    )?;

    search::index_words(db, &id)
}

impl Store {
    pub fn is_listed(&self, space: Uuid, id: Uuid) -> Result<bool, Error> {
        is_listed(&self.0, space, id)
    }

    pub fn is_registered(&self, space: Uuid, id: Uuid) -> Result<bool, Error> {
        is_registered(&self.0, space, id)
    }

    pub fn listings(&self, space: Uuid) -> Result<Vec<Uuid>, Error> {
        Ok(self
            .0
            .prepare("SELECT id FROM notes WHERE space=?1 AND kind='index' ORDER BY rowid")?
            .query_map([space.to_string()], |r| uuid_col(r, 0))?
            .collect::<Result<_, _>>()?)
    }

    pub fn listing_waits(&self, space: Uuid) -> Result<bool, Error> {
        Ok(self.0.query_row(
            "SELECT exists(SELECT 1 FROM outbox JOIN notes ON notes.id=outbox.id WHERE space=?1 AND kind IN ('workspace','index'))",
            [space.to_string()],
            |r| r.get(0),
        )?)
    }

    pub(crate) fn placed(&self, note: &Note) -> Result<Option<Placement>, Error> {
        if lists(&note.kind) {
            return Ok(None);
        }

        placed(&self.0, note.space, note.id)
    }
}
