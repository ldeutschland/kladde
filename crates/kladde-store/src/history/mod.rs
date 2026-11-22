mod automatic_versions;
mod change_size;

#[cfg(test)]
mod tests;

pub(crate) use automatic_versions::{capture, mark_saved};

use crate::{Error, Note, Store};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_LABEL_CHARS: usize = 80;

const JSON_OBJECT: u8 = b'{';

const LARGE_CHANGE: &str = "change";

const REMOTE: &str = "remote";

const REQUESTED_CAUSES: [&str; 3] = ["ai", "restore", "file"];

const ADDED_COLUMNS: [&str; 3] = ["label", "cause", "origin"];

const KEEP: &str = "INSERT INTO versions(id,rev,time,record,label,cause) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id,rev) DO UPDATE SET label=COALESCE(excluded.label,versions.label),cause=COALESCE(excluded.cause,versions.cause),origin=CASE WHEN excluded.cause IS NULL THEN versions.origin END";

const LISTING: &str = "SELECT v.rev,v.time,v.label,v.cause,f.file FROM versions v LEFT JOIN version_files f ON f.doc=v.id AND f.rev=v.rev WHERE v.id=?1 ORDER BY v.rev DESC";

#[derive(Debug, PartialEq, Serialize)]
pub struct Version {
    pub rev: i64,
    pub time: i64,
    pub label: Option<String>,
    pub cause: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

pub(crate) fn now() -> i64 {
    let elapsed = SystemTime::now().duration_since(UNIX_EPOCH);

    elapsed.map_or(0, |time| time.as_secs() as i64)
}

pub(crate) fn add_columns(db: &Connection) -> Result<(), Error> {
    for column in ADDED_COLUMNS {
        let present: bool = db.query_row(
            "SELECT exists(SELECT 1 FROM pragma_table_info('versions') WHERE name=?1)",
            [column],
            |r| r.get(0),
        )?;

        if !present {
            db.execute_batch(&format!("ALTER TABLE versions ADD COLUMN {column} TEXT"))?;
        }
    }

    Ok(())
}

pub(crate) fn decode(record: &[u8]) -> Result<Note, Error> {
    if record.first() == Some(&JSON_OBJECT) {
        return serde_json::from_slice(record).map_err(|_| Error::Invalid);
    }

    kladde_protocol::decode(record).map_err(|_| Error::Invalid)
}

pub(crate) fn clean_label(label: &str) -> Result<String, Error> {
    let label = label.trim();
    let sized = (1..=MAX_LABEL_CHARS).contains(&label.chars().count());

    if !sized || label.chars().any(char::is_control) {
        return Err(Error::Invalid);
    }

    Ok(label.to_string())
}

pub(crate) fn known_cause(cause: &str, origin: Option<&str>) -> bool {
    let named = cause == LARGE_CHANGE || REQUESTED_CAUSES.contains(&cause);

    named && origin.is_none_or(|origin| origin == REMOTE)
}

fn requested_cause(cause: Option<&str>) -> Result<Option<&'static str>, Error> {
    let Some(cause) = cause else {
        return Ok(None);
    };

    let known = REQUESTED_CAUSES.into_iter().find(|known| *known == cause);

    known.map(Some).ok_or(Error::Invalid)
}

fn insert(
    db: &Connection,
    note: &Note,
    time: i64,
    label: Option<&str>,
    cause: Option<&str>,
) -> Result<(), Error> {
    let record = kladde_protocol::encode(note).map_err(|_| Error::Invalid)?;
    let id = note.id.to_string();

    db.execute(KEEP, params![id, note.rev, time, record, label, cause])?;

    Ok(())
}

impl Store {
    pub fn versions(&self, id: Uuid) -> Result<Vec<Version>, Error> {
        Ok(self
            .0
            .prepare(LISTING)?
            .query_map([id.to_string()], |r| {
                Ok(Version {
                    rev: r.get(0)?,
                    time: r.get(1)?,
                    label: r.get(2)?,
                    cause: r.get(3)?,
                    file: r.get(4)?,
                })
            })?
            .collect::<Result<_, _>>()?)
    }

    pub fn version(&self, id: Uuid, rev: i64) -> Result<Note, Error> {
        let record: Option<Vec<u8>> = self
            .0
            .query_row(
                "SELECT record FROM versions WHERE id=?1 AND rev=?2",
                params![id.to_string(), rev],
                |r| r.get(0),
            )
            .optional()?;
        let note = decode(&record.ok_or(Error::Invalid)?)?;

        if note.id != id || note.rev != rev {
            return Err(Error::Invalid);
        }

        Ok(note)
    }

    pub fn keep_version(
        &mut self,
        id: Uuid,
        label: Option<&str>,
        cause: Option<&str>,
    ) -> Result<i64, Error> {
        let label = label.map(clean_label).transpose()?;
        let cause = requested_cause(cause)?;
        let current = self.get(id)?.ok_or(Error::Invalid)?;

        insert(&self.0, &current, now(), label.as_deref(), cause)?;

        Ok(current.rev)
    }

    pub fn label_version(&self, id: Uuid, rev: i64, label: Option<&str>) -> Result<(), Error> {
        let label = label.map(clean_label).transpose()?;
        let changed = self.0.execute(
            "UPDATE versions SET label=?3 WHERE id=?1 AND rev=?2",
            params![id.to_string(), rev, label],
        )?;

        if changed != 1 {
            return Err(Error::Invalid);
        }

        Ok(())
    }

    pub fn delete_version(&self, id: Uuid, rev: i64) -> Result<(), Error> {
        self.0.execute(
            "DELETE FROM versions WHERE id=?1 AND rev=?2",
            params![id.to_string(), rev],
        )?;

        Ok(())
    }
}
