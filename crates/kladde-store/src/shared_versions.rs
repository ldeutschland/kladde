use crate::{
    Error, Note, Store, history,
    part_hashes::{self, Hash},
    parts,
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use uuid::Uuid;

pub(crate) const LISTED_MAP: &str = "versions";
const SHARED_KINDS: [&str; 3] = ["page", "row", "database"];
const BATCH: i64 = 16;
const CREATED: i64 = 0;
const LISTED: i64 = 1;
const RETRACTED: i64 = 2;
const WAITING: &str = "SELECT v.rev,v.record FROM versions v WHERE v.id=?1 AND (v.label IS NOT NULL OR (v.cause IS NOT NULL AND v.origin IS NULL)) AND NOT EXISTS(SELECT 1 FROM version_files f WHERE f.doc=v.id AND f.rev=v.rev) ORDER BY v.rev DESC LIMIT ?2";
const ANCHOR: &str = "SELECT time,label,cause FROM versions WHERE id=?1 AND rev=?2 AND (label IS NOT NULL OR (cause IS NOT NULL AND origin IS NULL))";
const RECORD: &str = "SELECT record FROM versions WHERE id=?1 AND rev=?2";

#[derive(Debug, PartialEq, Serialize)]
pub struct SharedVersion {
    pub file: Uuid,
    pub time: i64,
    pub label: Option<String>,
    pub cause: Option<String>,
    pub sha256: String,
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Shares {
    pub own: Vec<SharedVersion>,
    pub gone: Vec<Uuid>,
}

pub(crate) struct Share {
    pub(crate) file: Uuid,
    pub(crate) rev: Option<i64>,
    pub(crate) state: i64,
}

pub(crate) fn known_state(state: i64) -> bool {
    [CREATED, LISTED, RETRACTED].contains(&state)
}

pub(crate) fn shares(db: &Connection, doc: &str) -> Result<Vec<Share>, Error> {
    let mut stmt = db.prepare("SELECT file,rev,state FROM version_files WHERE doc=?1")?;
    let rows = stmt.query_map([doc], |r| {
        Ok(Share {
            file: crate::uuid_col(r, 0)?,
            rev: r.get(1)?,
            state: r.get(2)?,
        })
    })?;

    Ok(rows.collect::<Result<_, _>>()?)
}

fn record_hash(db: &Connection, doc: &str, rev: i64) -> Result<Hash, Error> {
    let record: Vec<u8> = db.query_row(RECORD, params![doc, rev], |r| r.get(0))?;

    Ok(Sha256::digest(record).into())
}

fn anchor(
    db: &Connection,
    doc: &str,
    share: &Share,
    hashes: &BTreeMap<Uuid, Hash>,
) -> Result<Option<SharedVersion>, Error> {
    let Some(rev) = share.rev else {
        return Ok(None);
    };

    let found = db.query_row(ANCHOR, params![doc, rev], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    });
    let Some((time, label, cause)) = found.optional()? else {
        return Ok(None);
    };

    let hash = match hashes.get(&share.file) {
        Some(listed) => *listed,
        None => record_hash(db, doc, rev)?,
    };

    Ok(Some(SharedVersion {
        file: share.file,
        time,
        label,
        cause,
        sha256: hex::encode(hash),
    }))
}

pub(crate) fn owned_elsewhere(db: &Connection, doc: &str, file: &str) -> Result<bool, Error> {
    let owner: Option<String> = db
        .query_row("SELECT doc FROM file_owners WHERE id=?1", [file], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(owner.is_some_and(|owner| owner != doc))
}

fn erase(db: &Connection, note: &Note, file: Uuid) -> Result<(), Error> {
    let (id, doc) = (file.to_string(), note.id.to_string());

    db.execute(
        "DELETE FROM version_files WHERE file=?1 AND doc=?2",
        params![id, doc],
    )?;

    if owned_elsewhere(db, &doc, &id)? {
        return Ok(());
    }

    db.execute(
        "DELETE FROM file_owners WHERE id=?1 AND doc=?2",
        params![id, doc],
    )?;
    db.execute(
        "DELETE FROM private_state WHERE id=?1",
        [format!("asset:{}:{file}", note.space)],
    )?;
    db.execute(
        "INSERT OR IGNORE INTO erased_files VALUES(?1,?2)",
        params![id, note.space.to_string()],
    )?;

    Ok(())
}

fn set_state(db: &Connection, file: Uuid, state: i64) -> Result<(), Error> {
    db.execute(
        "UPDATE version_files SET state=?2 WHERE file=?1",
        params![file.to_string(), state],
    )?;

    Ok(())
}

fn settle(
    db: &Connection,
    note: &Note,
    share: &Share,
    listed: bool,
    hashes: &BTreeMap<Uuid, Hash>,
    result: &mut Shares,
) -> Result<(), Error> {
    let doc = note.id.to_string();
    let kept = match share.state {
        RETRACTED => None,
        _ => anchor(db, &doc, share, hashes)?,
    };

    match (kept, listed, share.state) {
        (Some(version), true, _) => {
            set_state(db, share.file, LISTED)?;
            result.own.push(version);
        }
        (Some(version), false, CREATED) => result.own.push(version),
        (Some(_), false, _) => {
            db.execute(
                "DELETE FROM versions WHERE id=?1 AND rev=?2",
                params![doc, share.rev],
            )?;
            erase(db, note, share.file)?;
        }
        (None, true, _) if share.rev.is_some() => {
            set_state(db, share.file, RETRACTED)?;
            result.gone.push(share.file);
        }
        (None, true, _) => {}
        (None, false, _) => erase(db, note, share.file)?,
    }

    Ok(())
}

impl Store {
    fn shared_note(&self, space: Uuid, doc: Uuid) -> Result<Option<Note>, Error> {
        let note = self.get(doc)?.filter(|note| note.space == space);
        let note = note.ok_or(Error::Invalid)?;

        Ok(SHARED_KINDS.contains(&note.kind.as_str()).then_some(note))
    }

    pub fn unshared_versions(&self, space: Uuid, doc: Uuid) -> Result<Vec<(i64, Vec<u8>)>, Error> {
        if self.shared_note(space, doc)?.is_none() {
            return Ok(Vec::new());
        }

        let mut stmt = self.0.prepare(WAITING)?;
        let rows = stmt.query_map(params![doc.to_string(), BATCH], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;

        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn mark_shared(&self, doc: Uuid, rev: i64, file: Uuid) -> Result<(), Error> {
        self.0.execute(
            "INSERT INTO version_files VALUES(?1,?2,?3,?4)",
            params![file.to_string(), doc.to_string(), rev, CREATED],
        )?;

        Ok(())
    }

    pub fn reconcile_shared(&mut self, space: Uuid, doc: Uuid) -> Result<Shares, Error> {
        let Some(note) = self.shared_note(space, doc)? else {
            return Ok(Shares::default());
        };

        let listed = parts::listed_ids(&note.data, LISTED_MAP)?;
        let hashes = part_hashes::version_hashes(&note.data)?;
        let tx = self.0.savepoint()?;
        let mut result = Shares::default();

        for share in shares(&tx, &doc.to_string())? {
            let known = listed.contains(&share.file);

            settle(&tx, &note, &share, known, &hashes, &mut result)?;
        }

        tx.commit()?;

        Ok(result)
    }

    pub fn shared_version(
        &mut self,
        space: Uuid,
        doc: Uuid,
        file: Uuid,
        record: &[u8],
    ) -> Result<Note, Error> {
        let current = self.shared_note(space, doc)?.ok_or(Error::Invalid)?;
        let note = history::decode(record)?;

        if note.id != doc || note.space != space || note.kind != current.kind {
            return Err(Error::Invalid);
        }

        if !self.may_be_version(&current, file)? {
            return Err(Error::Invalid);
        }

        self.0.execute(
            "INSERT OR IGNORE INTO version_files VALUES(?1,?2,NULL,?3)",
            params![file.to_string(), doc.to_string(), LISTED],
        )?;

        Ok(note)
    }

    fn may_be_version(&self, note: &Note, file: Uuid) -> Result<bool, Error> {
        let listed = parts::listed_ids(&note.data, LISTED_MAP)?.contains(&file);
        let attached = parts::stored_files(&note.data)?.contains(&file);
        let foreign = owned_elsewhere(&self.0, &note.id.to_string(), &file.to_string())?;

        Ok(listed && !attached && !foreign)
    }

    pub fn knows_shared(&self, doc: Uuid, file: Uuid) -> Result<bool, Error> {
        Ok(self.0.query_row(
            "SELECT exists(SELECT 1 FROM version_files WHERE file=?1 AND doc=?2)",
            params![file.to_string(), doc.to_string()],
            |r| r.get(0),
        )?)
    }

    pub fn erase_shared(&mut self, space: Uuid, doc: Uuid, file: Uuid) -> Result<(), Error> {
        let note = self.shared_note(space, doc)?.ok_or(Error::Invalid)?;

        if !self.may_be_version(&note, file)? {
            return Err(Error::Invalid);
        }

        let tx = self.0.savepoint()?;
        let known: Option<Option<i64>> = tx
            .query_row(
                "SELECT rev FROM version_files WHERE file=?1 AND doc=?2",
                params![file.to_string(), doc.to_string()],
                |r| r.get(0),
            )
            .optional()?;
        let Some(rev) = known else {
            return Err(Error::Invalid);
        };

        if let Some(rev) = rev {
            tx.execute(
                "DELETE FROM versions WHERE id=?1 AND rev=?2",
                params![doc.to_string(), rev],
            )?;
        }

        erase(&tx, &note, file)?;
        tx.commit()?;

        Ok(())
    }
}
