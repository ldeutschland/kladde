use super::{Error, MAX_BACKUP_BYTES, Note, Store};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
pub struct Archive {
    pub notes: Vec<Note>,
    pub history: Vec<HistoryEntry>,
    pub files: Vec<(Uuid, Vec<u8>)>,
    pub owners: Vec<(Uuid, Uuid)>,
}

impl Archive {
    pub fn missing_files(&self) -> Result<Vec<(Uuid, Uuid)>, Error> {
        use std::collections::{BTreeMap, BTreeSet};
        use yrs::{Doc, Map, Transact, Update};

        let available: BTreeSet<_> = self.files.iter().map(|(id, _)| *id).collect();
        let mut missing = BTreeMap::new();
        let mut inspect = |note: &Note| -> Result<(), Error> {
            let doc = Doc::new();
            let files = doc.get_or_insert_map("files");

            doc.transact_mut()
                .apply_update(Update::decode_complete_v1(&note.data).map_err(|_| Error::Invalid)?)
                .map_err(|_| Error::Invalid)?;
            let tx = doc.transact();

            for key in files.keys(&tx) {
                let id: Uuid = key.parse().map_err(|_| Error::Invalid)?;

                if id.get_version_num() != 4 {
                    return Err(Error::Invalid);
                }

                if !available.contains(&id)
                    && missing
                        .insert(id, note.id)
                        .is_some_and(|other| other != note.id)
                {
                    return Err(Error::Invalid);
                }
            }

            Ok(())
        };

        for note in &self.notes {
            inspect(note)?
        }

        for (_, _, _, record) in &self.history {
            inspect(&super::history::decode(record)?)?;
        }

        Ok(missing.into_iter().map(|(file, doc)| (doc, file)).collect())
    }
}

type HistoryEntry = (Uuid, i64, i64, Vec<u8>);

const MAX_ARCHIVED_NOTES: usize = 50000;
const MAX_VERSIONS_PER_NOTE: usize = 24;

fn count_bytes(total: &mut usize, added: usize) -> Result<(), Error> {
    *total += added;

    if *total > MAX_BACKUP_BYTES {
        return Err(Error::Invalid);
    }

    Ok(())
}

impl Store {
    pub fn archive(&self, space: Uuid) -> Result<Archive, Error> {
        let mut total = 0usize;
        let notes = self.archived_notes(space, &mut total)?;
        let history = self.archived_history(space, &mut total)?;
        let files = self.archived_files(space, &mut total)?;
        let owners = self
            .0
            .prepare("SELECT id,doc FROM file_owners WHERE space=?1")?
            .query_map([space.to_string()], |row| {
                Ok((super::uuid_col(row, 0)?, super::uuid_col(row, 1)?))
            })?
            .collect::<Result<_, _>>()?;
        Ok(Archive {
            owners,
            notes,
            history,
            files,
        })
    }

    fn archived_notes(&self, space: Uuid, total: &mut usize) -> Result<Vec<Note>, Error> {
        let mut notes = vec![];

        for id in self.ids(space)? {
            let note = self.get(id)?.ok_or(Error::Invalid)?;

            count_bytes(total, note.data.len() + note.body.len())?;

            notes.push(note)
        }

        Ok(notes)
    }

    fn archived_history(&self, space: Uuid, total: &mut usize) -> Result<Vec<HistoryEntry>, Error> {
        let mut history = vec![];
        let mut stmt=self.0.prepare("SELECT v.id,v.rev,v.time,v.record FROM versions v JOIN notes n ON n.id=v.id WHERE n.space=?1")?;

        for row in stmt.query_map([space.to_string()], |row| {
            Ok((
                super::uuid_col(row, 0)?,
                row.get(1)?,
                row.get(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })? {
            let row = row?;

            count_bytes(total, row.3.len())?;

            history.push(row)
        }

        Ok(history)
    }

    fn archived_files(
        &self,
        space: Uuid,
        total: &mut usize,
    ) -> Result<Vec<(Uuid, Vec<u8>)>, Error> {
        let mut files = vec![];
        let prefix = format!("asset:{space}:");

        for name in self.state_keys(&prefix)? {
            let id = name
                .strip_prefix(&prefix)
                .ok_or(Error::Invalid)?
                .parse()
                .map_err(|_| Error::Invalid)?;
            let value = self.state(&name)?.ok_or(Error::Invalid)?;

            count_bytes(total, value.len())?;

            files.push((id, value))
        }

        Ok(files)
    }

    pub fn restore_archive(&mut self, space: Uuid, mut archive: Archive) -> Result<(), Error> {
        check_archive(space, &archive)?;
        let revisions = self.reset_revisions(space, &mut archive.notes)?;

        self.0.execute_batch("SAVEPOINT restore_archive")?;
        let result = self.restore_contents(space, archive, &revisions);

        if result.is_err() {
            self.0.execute_batch("ROLLBACK TO restore_archive")?
        }

        self.0.execute_batch("RELEASE restore_archive")?;

        result
    }

    fn reset_revisions(
        &self,
        space: Uuid,
        notes: &mut [Note],
    ) -> Result<HashMap<Uuid, i64>, Error> {
        let mut revisions = HashMap::new();

        for note in notes {
            if note.space != space
                || note.rev < 1
                || note.rev == i64::MAX
                || self.get(note.id)?.is_some()
                || revisions.insert(note.id, note.rev).is_some()
            {
                return Err(Error::Conflict);
            }

            note.rev = 0
        }

        Ok(revisions)
    }

    fn restore_contents(
        &mut self,
        space: Uuid,
        archive: Archive,
        revisions: &HashMap<Uuid, i64>,
    ) -> Result<(), Error> {
        self.save_with(&archive.notes, false, None)?;

        for (id, rev) in revisions {
            self.0.execute(
                "UPDATE notes SET rev=?2 WHERE id=?1",
                params![id.to_string(), rev],
            )?;
        }

        self.restore_history(space, archive.history, revisions)?;
        self.restore_files(space, archive.files)?;

        self.restore_owners(space, archive.owners, revisions)
    }

    fn restore_history(
        &self,
        space: Uuid,
        history: Vec<HistoryEntry>,
        revisions: &HashMap<Uuid, i64>,
    ) -> Result<(), Error> {
        for (id, rev, time, raw) in history {
            let old = super::history::decode(&raw)?;

            if old.space != space
                || old.id != id
                || old.rev != rev
                || rev < 1
                || revisions.get(&id).is_none_or(|current| rev >= *current)
            {
                return Err(Error::Invalid);
            }

            self.0.execute(
                "INSERT INTO versions(id,rev,time,record) VALUES(?1,?2,?3,?4)",
                params![id.to_string(), rev, time, raw],
            )?;
        }

        Ok(())
    }

    fn restore_files(&self, space: Uuid, files: Vec<(Uuid, Vec<u8>)>) -> Result<(), Error> {
        for (id, bytes) in files {
            if id.get_version_num() != 4 || bytes.len() > kladde_protocol::MAX_ENCODED_ATTACHMENT {
                return Err(Error::Invalid);
            }

            self.set_state(&format!("asset:{space}:{id}"), &bytes)?;
        }

        Ok(())
    }

    fn restore_owners(
        &self,
        space: Uuid,
        owners: Vec<(Uuid, Uuid)>,
        revisions: &HashMap<Uuid, i64>,
    ) -> Result<(), Error> {
        for (id, doc) in owners {
            if !revisions.contains_key(&doc)
                || self.state(&format!("asset:{space}:{id}"))?.is_none()
            {
                return Err(Error::Invalid);
            }

            self.0.execute(
                "INSERT INTO file_owners VALUES(?1,?2,?3)",
                params![id.to_string(), doc.to_string(), space.to_string()],
            )?;
        }

        Ok(())
    }
}

fn check_archive(space: Uuid, archive: &Archive) -> Result<(), Error> {
    if !archive
        .notes
        .iter()
        .any(|note| note.id == space && note.kind == "workspace")
        || archive.notes.len() > MAX_ARCHIVED_NOTES
        || archive.history.len() > MAX_ARCHIVED_NOTES * MAX_VERSIONS_PER_NOTE
        || archive.owners.len() > archive.files.len()
        || archive.files.len() > MAX_ARCHIVED_NOTES
    {
        return Err(Error::Invalid);
    }

    Ok(())
}
