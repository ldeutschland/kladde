use crate::{Error, Note, Store, history, parts::stored_files, shared_versions, uuid_col};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use uuid::Uuid;

const MARKER: &str = "restore:";
const RECORD_FRAME: usize = 128;
const LINK_BYTES: usize = 17;
const PURGE_SPACE: [&str; 8] = [
    "DELETE FROM file_words WHERE rowid IN (SELECT f.rowid FROM page_files f JOIN notes n ON n.id=f.doc WHERE n.space=?1)",
    "DELETE FROM private_state WHERE substr(id,1,43)='asset:' || ?1 || ':'",
    "DELETE FROM file_owners WHERE space=?1",
    "DELETE FROM page_artwork WHERE space=?1",
    "DELETE FROM words WHERE space=?1",
    "DELETE FROM listing WHERE space=?1",
    "DELETE FROM row_marks WHERE id IN (SELECT id FROM notes WHERE space=?1)",
    "DELETE FROM notes WHERE space=?1",
];

#[derive(Serialize, Deserialize)]
pub enum Record {
    Note(Note),
    Version {
        id: Uuid,
        rev: i64,
        time: i64,
        record: Vec<u8>,
    },
    File {
        id: Uuid,
        doc: Uuid,
        bytes: Vec<u8>,
    },
    Label {
        id: Uuid,
        rev: i64,
        label: String,
    },
    Cause {
        id: Uuid,
        rev: i64,
        cause: String,
        origin: Option<String>,
    },
    Shared {
        id: Uuid,
        file: Uuid,
        rev: Option<i64>,
        state: i64,
    },
}

impl Record {
    pub fn weight(&self) -> usize {
        let content = match self {
            Self::Note(note) => note_content(note),
            Self::Version { record, .. } => record.len(),
            Self::File { bytes, .. } => bytes.len(),
            Self::Label { label, .. } => label.len(),
            Self::Cause { cause, origin, .. } => {
                cause.len() + origin.as_ref().map_or(0, String::len)
            }
            Self::Shared { .. } => 0,
        };

        RECORD_FRAME + content
    }
}

fn note_content(note: &Note) -> usize {
    note.data.len()
        + note.body.len()
        + note.props.len()
        + note.title.len()
        + note.kind.len()
        + note.links.len() * LINK_BYTES
}

struct StoredVersion {
    rev: i64,
    time: i64,
    record: Vec<u8>,
    label: Option<String>,
    cause: Option<String>,
    origin: Option<String>,
}

fn push_version(bundle: &mut Bundle, id: Uuid, kept: StoredVersion) {
    let rev = kept.rev;

    bundle.records.push(Record::Version {
        id,
        rev,
        time: kept.time,
        record: kept.record,
    });

    if let Some(label) = kept.label {
        bundle.records.push(Record::Label { id, rev, label });
    }

    if let Some(cause) = kept.cause {
        let origin = kept.origin;

        bundle.records.push(Record::Cause {
            id,
            rev,
            cause,
            origin,
        });
    }
}

#[derive(Default)]
pub struct Bundle {
    pub records: Vec<Record>,
    pub missing: Vec<(Uuid, Uuid)>,
}

fn asset_key(space: Uuid, file: Uuid) -> String {
    format!("asset:{space}:{file}")
}

impl Store {
    pub fn backup_order(&self, space: Uuid) -> Result<Vec<Uuid>, Error> {
        Ok(self
            .0
            .prepare("SELECT id FROM notes WHERE space=?1 ORDER BY kind='workspace',rowid")?
            .query_map([space.to_string()], |r| uuid_col(r, 0))?
            .collect::<Result<_, _>>()?)
    }

    pub fn backup_bundle(&self, space: Uuid, id: Uuid) -> Result<Bundle, Error> {
        let Some(note) = self.get(id)?.filter(|note| note.space == space) else {
            return Ok(Bundle::default());
        };

        let mut wanted: BTreeSet<Uuid> = stored_files(&note.data)?.into_iter().collect();
        let mut bundle = Bundle::default();

        bundle.records.push(Record::Note(note));

        for kept in self.history_of(id)? {
            wanted.extend(stored_files(&history::decode(&kept.record)?.data)?);
            push_version(&mut bundle, id, kept);
        }

        wanted.extend(self.owned_files(space, id)?);
        self.add_files(space, id, wanted, &mut bundle)?;

        for share in shared_versions::shares(&self.0, &id.to_string())? {
            let (file, rev, state) = (share.file, share.rev, share.state);

            bundle.records.push(Record::Shared {
                id,
                file,
                rev,
                state,
            });
        }

        Ok(bundle)
    }

    fn history_of(&self, id: Uuid) -> Result<Vec<StoredVersion>, Error> {
        Ok(self
            .0
            .prepare(
                "SELECT rev,time,record,label,cause,origin FROM versions WHERE id=?1 ORDER BY rev",
            )?
            .query_map([id.to_string()], |r| {
                Ok(StoredVersion {
                    rev: r.get(0)?,
                    time: r.get(1)?,
                    record: r.get(2)?,
                    label: r.get(3)?,
                    cause: r.get(4)?,
                    origin: r.get(5)?,
                })
            })?
            .collect::<Result<_, _>>()?)
    }

    fn owned_files(&self, space: Uuid, doc: Uuid) -> Result<Vec<Uuid>, Error> {
        Ok(self
            .0
            .prepare("SELECT id FROM file_owners WHERE doc=?1 AND space=?2")?
            .query_map(params![doc.to_string(), space.to_string()], |r| {
                uuid_col(r, 0)
            })?
            .collect::<Result<_, _>>()?)
    }

    fn owner_of(&self, file: Uuid) -> Result<Option<Uuid>, Error> {
        use rusqlite::OptionalExtension;

        Ok(self
            .0
            .query_row(
                "SELECT doc FROM file_owners WHERE id=?1",
                [file.to_string()],
                |r| uuid_col(r, 0),
            )
            .optional()?)
    }

    fn add_files(
        &self,
        space: Uuid,
        doc: Uuid,
        wanted: BTreeSet<Uuid>,
        bundle: &mut Bundle,
    ) -> Result<(), Error> {
        for id in wanted {
            let owner = self.owner_of(id)?;

            if owner.is_some_and(|owner| owner != doc) {
                continue;
            }

            match self.state(&asset_key(space, id))? {
                Some(bytes) => bundle.records.push(Record::File { id, doc, bytes }),
                None => bundle.missing.push((doc, id)),
            }
        }

        Ok(())
    }

    pub fn begin_restore(&mut self, space: Uuid) -> Result<(), Error> {
        let taken: bool = self.0.query_row(
            "SELECT exists(SELECT 1 FROM notes WHERE space=?1)",
            [space.to_string()],
            |r| r.get(0),
        )?;

        if taken || space.get_version_num() != 4 {
            return Err(Error::Conflict);
        }

        self.set_state(&format!("{MARKER}{space}"), &[1])
    }

    pub fn restore_records(&mut self, space: Uuid, records: Vec<Record>) -> Result<(), Error> {
        if self.state(&format!("{MARKER}{space}"))?.is_none() {
            return Err(Error::Invalid);
        }

        self.0.execute_batch("SAVEPOINT restore_records")?;
        let result = records
            .into_iter()
            .try_for_each(|record| self.restore_record(space, record));
        if result.is_err() {
            self.0.execute_batch("ROLLBACK TO restore_records")?;
        }

        self.0.execute_batch("RELEASE restore_records")?;

        result
    }

    fn restore_record(&mut self, space: Uuid, record: Record) -> Result<(), Error> {
        match record {
            Record::Note(note) => self.restore_note(space, note),
            Record::Version {
                id,
                rev,
                time,
                record,
            } => self.restore_version(space, id, (rev, time), &record),
            Record::File { id, doc, bytes } => self.restore_file(space, id, doc, &bytes),
            Record::Label { id, rev, label } => self.restore_label(space, id, rev, &label),
            Record::Cause {
                id,
                rev,
                cause,
                origin,
            } => self.restore_cause(space, id, rev, (&cause, origin.as_deref())),
            Record::Shared {
                id,
                file,
                rev,
                state,
            } => self.restore_shared(space, id, file, (rev, state)),
        }
    }

    fn owns(&self, space: Uuid, id: Uuid) -> Result<bool, Error> {
        Ok(self.revision(id)?.is_some_and(|(owner, ..)| owner == space))
    }

    fn restore_note(&mut self, space: Uuid, mut note: Note) -> Result<(), Error> {
        let rev = note.rev;

        if note.space != space || rev < 1 || rev == i64::MAX || self.get(note.id)?.is_some() {
            return Err(Error::Conflict);
        }

        let id = note.id.to_string();

        note.rev = 0;
        self.save_with(&[note], false, None)?;
        self.0
            .execute("UPDATE notes SET rev=?2 WHERE id=?1", params![id, rev])?;
        Ok(())
    }

    fn restore_version(
        &mut self,
        space: Uuid,
        id: Uuid,
        (rev, time): (i64, i64),
        record: &[u8],
    ) -> Result<(), Error> {
        let old = history::decode(record)?;
        let current = self.revision(id)?.filter(|(owner, ..)| *owner == space);
        let newer = current.is_some_and(|(_, _, latest)| rev < latest);

        if old.space != space || old.id != id || old.rev != rev || rev < 1 || !newer {
            return Err(Error::Invalid);
        }

        self.0.execute(
            "INSERT INTO versions(id,rev,time,record) VALUES(?1,?2,?3,?4)",
            params![id.to_string(), rev, time, record],
        )?;

        Ok(())
    }

    fn restore_label(&mut self, space: Uuid, id: Uuid, rev: i64, label: &str) -> Result<(), Error> {
        if !self.owns(space, id)? || history::clean_label(label)? != label {
            return Err(Error::Invalid);
        }

        self.label_version(id, rev, Some(label))
    }

    fn restore_cause(
        &mut self,
        space: Uuid,
        id: Uuid,
        rev: i64,
        (cause, origin): (&str, Option<&str>),
    ) -> Result<(), Error> {
        if !self.owns(space, id)? || !history::known_cause(cause, origin) {
            return Err(Error::Invalid);
        }

        let changed = self.0.execute(
            "UPDATE versions SET cause=?3,origin=?4 WHERE id=?1 AND rev=?2",
            params![id.to_string(), rev, cause, origin],
        )?;

        if changed != 1 {
            return Err(Error::Invalid);
        }

        Ok(())
    }

    fn restore_shared(
        &mut self,
        space: Uuid,
        id: Uuid,
        file: Uuid,
        (rev, state): (Option<i64>, i64),
    ) -> Result<(), Error> {
        let (doc, name) = (id.to_string(), file.to_string());
        let valid = self.owns(space, id)?
            && file.get_version_num() == 4
            && rev.is_none_or(|rev| rev >= 1)
            && shared_versions::known_state(state)
            && !shared_versions::owned_elsewhere(&self.0, &doc, &name)?;
        if !valid {
            return Err(Error::Invalid);
        }

        self.0.execute(
            "INSERT INTO version_files VALUES(?1,?2,?3,?4)",
            params![name, doc, rev, state],
        )?;

        Ok(())
    }

    fn restore_file(
        &mut self,
        space: Uuid,
        id: Uuid,
        doc: Uuid,
        bytes: &[u8],
    ) -> Result<(), Error> {
        let owned = self.owns(space, doc)?;
        let sized = bytes.len() <= kladde_protocol::MAX_ENCODED_ATTACHMENT;

        if !owned || !sized || id.get_version_num() != 4 {
            return Err(Error::Invalid);
        }

        self.set_state(&asset_key(space, id), bytes)?;
        self.0.execute(
            "INSERT INTO file_owners VALUES(?1,?2,?3)",
            params![id.to_string(), doc.to_string(), space.to_string()],
        )?;

        Ok(())
    }

    pub fn finish_restore(&mut self, space: Uuid) -> Result<(), Error> {
        let complete = self
            .revision(space)?
            .is_some_and(|(owner, kind, _)| owner == space && kind == "workspace");
        if !complete {
            return Err(Error::Invalid);
        }

        self.clear_state(&format!("{MARKER}{space}"))
    }

    pub fn abandon_restore(&mut self, space: Uuid) -> Result<(), Error> {
        if self.state(&format!("{MARKER}{space}"))?.is_none() {
            return Ok(());
        }

        abandon(&self.0, space)
    }
}

pub(crate) fn abandon_all(db: &Connection) -> Result<(), Error> {
    let marked = db
        .prepare("SELECT id FROM private_state WHERE substr(id,1,8)=?1")?
        .query_map([MARKER], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for key in marked {
        let space = key[MARKER.len()..].parse().map_err(|_| Error::Invalid)?;

        abandon(db, space)?;
    }

    Ok(())
}

fn abandon(db: &Connection, space: Uuid) -> Result<(), Error> {
    let space = space.to_string();
    let complete: bool = db.query_row(
        "SELECT exists(SELECT 1 FROM notes WHERE id=?1 AND kind='workspace')",
        [&space],
        |r| r.get(0),
    )?;

    if !complete {
        for statement in PURGE_SPACE {
            db.execute(statement, [&space])?;
        }
    }

    db.execute(
        "DELETE FROM private_state WHERE id=?1",
        [format!("{MARKER}{space}")],
    )?;

    Ok(())
}
