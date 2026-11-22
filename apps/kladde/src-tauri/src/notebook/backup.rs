use crate::{
    attachments::{downloads_folder, encrypted_files, ipc_file_data::FileInput, relay_blobs},
    notebook::vault::Vault,
};

use kladde_crypto::{
    Key, Purpose, Wrapped,
    backup::{NONCE, Opener, Sealer},
    backup_key, random, unwrap,
};

use kladde_store::{Archive, MAX_BACKUP_BYTES, Record};
use serde::{Deserialize, Serialize};
use std::{fs::File, io::Write, sync::Mutex};
use tauri::{AppHandle, State};
use uuid::Uuid;
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"KLADDE2\n";
const PART_BYTES: usize = 4 * 1024 * 1024;
const PART_FRAME: usize = 64;
const PART_LIMIT: usize = MAX_BACKUP_BYTES - PART_FRAME;
const TOO_LARGE: &str = "Backup part too large";
const HEADER_LIMIT: usize = 1024;

#[derive(Serialize, Deserialize)]
struct Legacy {
    version: u8,
    space: Uuid,
    salt: [u8; 16],
    data: Wrapped,
}

#[derive(Serialize, Deserialize)]
struct Header {
    version: u8,
    space: Uuid,
    salt: [u8; 16],
    nonce: [u8; NONCE],
}

struct Restore {
    space: Uuid,
    opener: Opener,
}

#[derive(Default)]
pub struct Restores(Mutex<Option<Restore>>);

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn saved(error: std::io::Error) -> String {
    format!("Backup could not be saved ({})", error.kind())
}

#[tauri::command]
pub async fn export_backup(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    password: String,
    name: String,
) -> Result<String, String> {
    let password = Zeroizing::new(password);
    let header = Header {
        version: 2,
        space,
        salt: random(),
        nonce: random(),
    };

    let key = backup_key(password.as_bytes(), &header.salt).map_err(text)?;
    let (path, file) = downloads_folder::create(&app, &name)?;

    if let Err(problem) = write_backup(&app, &vault, &header, &key, file).await {
        let _ = std::fs::remove_file(&path);

        return Err(problem);
    }

    downloads_folder::reveal(&path);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned());

    Ok(name.unwrap_or_default())
}

async fn write_backup(
    app: &AppHandle,
    vault: &Vault,
    header: &Header,
    key: &Key,
    out: File,
) -> Result<(), String> {
    let mut writer = Writer::begin(out, header, key)?;

    for id in vault.access(app, |store| store.backup_order(header.space))? {
        writer.add(complete_bundle(app, vault, header.space, id).await?)?;
    }

    writer.finish()?.sync_all().map_err(saved)
}

struct Writer<W: Write> {
    out: W,
    sealer: Sealer,
    records: Vec<Record>,
    size: usize,
    limit: usize,
}

impl<W: Write> Writer<W> {
    fn begin(mut out: W, header: &Header, key: &Key) -> Result<Self, String> {
        let context = kladde_protocol::encode(header).map_err(text)?;

        out.write_all(MAGIC).map_err(saved)?;
        write_part(&mut out, &context)?;
        let sealer = Sealer::new(key, header.space, &header.nonce, context).map_err(text)?;

        Ok(Self {
            out,
            sealer,
            records: Vec::new(),
            size: 0,
            limit: PART_LIMIT,
        })
    }

    fn add(&mut self, records: Vec<Record>) -> Result<(), String> {
        for record in records {
            self.keep(record)?;
        }

        if self.size < PART_BYTES {
            return Ok(());
        }

        self.seal()
    }

    fn keep(&mut self, record: Record) -> Result<(), String> {
        let weight = record.weight();

        if weight > self.limit {
            return Err(TOO_LARGE.into());
        }

        if self.size + weight > self.limit {
            self.seal()?;
        }

        self.size += weight;
        self.records.push(record);

        Ok(())
    }

    fn seal(&mut self) -> Result<(), String> {
        let plain = self.take()?;
        let sealed = self.sealer.next(&plain).map_err(text)?;

        write_part(&mut self.out, &sealed)
    }

    fn take(&mut self) -> Result<Zeroizing<Vec<u8>>, String> {
        let records = std::mem::take(&mut self.records);

        self.size = 0;
        let encoded = postcard::to_allocvec(&records).map_err(|_| "Invalid backup")?;

        Ok(Zeroizing::new(encoded))
    }

    fn finish(mut self) -> Result<W, String> {
        let plain = self.take()?;
        let sealed = self.sealer.last(&plain).map_err(text)?;

        write_part(&mut self.out, &sealed)?;

        Ok(self.out)
    }
}

fn write_part(out: &mut impl Write, bytes: &[u8]) -> Result<(), String> {
    let length = u32::try_from(bytes.len()).map_err(|_| TOO_LARGE)?;

    out.write_all(&length.to_le_bytes()).map_err(saved)?;

    out.write_all(bytes).map_err(saved)
}

async fn complete_bundle(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    id: Uuid,
) -> Result<Vec<Record>, String> {
    let bundle = vault.access(app, |store| store.backup_bundle(space, id))?;
    let mut records = Vec::with_capacity(bundle.records.len() + bundle.missing.len());

    for record in bundle.records {
        records.push(intact(app, vault, space, record).await?);
    }

    for (doc, file) in bundle.missing {
        records.push(relay_blobs::fetch_for_backup(app, vault, space, doc, file).await?);
    }

    Ok(records)
}

async fn intact(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    record: Record,
) -> Result<Record, String> {
    match record {
        Record::File { id, doc, bytes } if !encrypted_files::is_intact(&bytes, doc, id) => {
            relay_blobs::fetch_for_backup(app, vault, space, doc, id).await
        }
        other => Ok(other),
    }
}

fn opener_for(context: Vec<u8>, password: &str) -> Result<(Uuid, Opener), String> {
    let (h, rest) = postcard::take_from_bytes::<Header>(&context).map_err(|_| "Invalid backup")?;

    if h.version != 2 || !rest.is_empty() {
        return Err("Unknown backup".into());
    }

    let key = backup_key(password.as_bytes(), &h.salt).map_err(text)?;
    let space = h.space;
    let opener = Opener::new(&key, space, &h.nonce, context).map_err(text)?;

    Ok((space, opener))
}

#[tauri::command]
pub fn import_backup_start(
    app: AppHandle,
    vault: State<Vault>,
    restores: State<Restores>,
    header: FileInput,
    password: String,
) -> Result<Uuid, String> {
    let password = Zeroizing::new(password);
    let (space, opener) = opener_for(header.bytes(HEADER_LIMIT)?.to_vec(), &password)?;
    let mut active = restores.0.lock().map_err(|_| "Restore unavailable")?;

    if let Some(stale) = active.take() {
        vault.access(&app, |store| store.abandon_restore(stale.space))?;
    }

    vault.access(&app, |store| store.begin_restore(space))?;
    *active = Some(Restore { space, opener });

    Ok(space)
}

#[tauri::command]
pub fn import_backup_part(
    app: AppHandle,
    vault: State<Vault>,
    restores: State<Restores>,
    data: FileInput,
    last: bool,
) -> Result<(), String> {
    let sealed = data.bytes(MAX_BACKUP_BYTES)?;
    let mut active = restores.0.lock().map_err(|_| "Restore unavailable")?;
    let restore = active.take().ok_or("No backup is being restored")?;
    let space = restore.space;

    match apply_part(&app, &vault, restore, &sealed, last) {
        Ok(next) => {
            *active = next;

            Ok(())
        }
        Err(problem) => {
            let _ = vault.access(&app, |store| store.abandon_restore(space));

            Err(problem)
        }
    }
}

fn apply_part(
    app: &AppHandle,
    vault: &Vault,
    restore: Restore,
    sealed: &[u8],
    last: bool,
) -> Result<Option<Restore>, String> {
    let Restore { space, mut opener } = restore;

    if !last {
        store_part(app, vault, space, &opener.next(sealed).map_err(text)?)?;

        return Ok(Some(Restore { space, opener }));
    }

    store_part(app, vault, space, &opener.last(sealed).map_err(text)?)?;
    vault.access(app, |store| store.finish_restore(space))?;
    crate::attachments::search_index::wake();

    Ok(None)
}

fn records_in(plain: &[u8]) -> Result<Vec<Record>, String> {
    let (records, rest) =
        postcard::take_from_bytes::<Vec<Record>>(plain).map_err(|_| "Invalid backup")?;
    if !rest.is_empty() {
        return Err("Invalid backup".into());
    }

    Ok(records)
}

fn store_part(app: &AppHandle, vault: &Vault, space: Uuid, plain: &[u8]) -> Result<(), String> {
    let records = records_in(plain)?;

    vault.access(app, |store| store.restore_records(space, records))
}

#[tauri::command]
pub fn import_backup_abort(
    app: AppHandle,
    vault: State<Vault>,
    restores: State<Restores>,
) -> Result<(), String> {
    let mut active = restores.0.lock().map_err(|_| "Restore unavailable")?;

    match active.take() {
        Some(restore) => vault.access(&app, |store| store.abandon_restore(restore.space)),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn import_backup(
    app: AppHandle,
    vault: State<Vault>,
    bytes: FileInput,
    password: String,
) -> Result<Uuid, String> {
    let password = Zeroizing::new(password);
    let bytes = bytes.bytes(MAX_BACKUP_BYTES)?;
    let (b, rest) = postcard::take_from_bytes::<Legacy>(&bytes).map_err(|_| "Invalid backup")?;

    if b.version != 1 || !rest.is_empty() {
        return Err("Unknown backup".into());
    }

    let key = backup_key(password.as_bytes(), &b.salt).map_err(text)?;
    let data = unwrap(key.as_ref(), b.space, Purpose::Backup, &b.data).map_err(text)?;
    let (archive, rest) =
        postcard::take_from_bytes::<Archive>(&data).map_err(|_| "Invalid backup")?;
    if !rest.is_empty() {
        return Err("Invalid backup".into());
    }

    vault.access(&app, |store| store.restore_archive(b.space, archive))?;
    crate::attachments::search_index::wake();

    Ok(b.space)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kladde_store::{Note, Store};

    const PASSWORD: &str = "test-only-long-password";
    const FILE_BYTES: usize = 300;
    const NARROW_PART: usize = 2 * FILE_BYTES;

    fn open(name: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("kladde-backup-{}-{name}", Uuid::new_v4()));

        std::fs::create_dir_all(&dir).unwrap();

        (Store::open(&dir.join("notebook"), &[5; 32]).unwrap(), dir)
    }

    fn note(space: Uuid, id: Uuid, kind: &str, title: &str, rev: i64) -> Note {
        Note {
            id,
            space,
            kind: kind.into(),
            title: title.into(),
            body: "Inhalt".into(),
            parent: None,
            archived: false,
            props: "{}".into(),
            links: vec![],
            data: vec![0, 0],
            rev,
        }
    }

    fn filled(store: &mut Store, pages: usize) -> (Uuid, Vec<Uuid>, Uuid) {
        let space = Uuid::new_v4();
        let ids: Vec<Uuid> = (0..pages).map(|_| Uuid::new_v4()).collect();

        store
            .save(&[note(space, space, "workspace", "Notizbuch", 0)], false)
            .unwrap();
        for id in &ids {
            store
                .save(&[note(space, *id, "page", "eins", 0)], false)
                .unwrap();
            store
                .save(&[note(space, *id, "page", "zwei", 1)], false)
                .unwrap();
        }

        let file = Uuid::new_v4();

        store
            .store_asset(space, ids[0], file, &[7; FILE_BYTES])
            .unwrap();
        (space, ids, file)
    }

    fn writer(space: Uuid) -> Writer<Vec<u8>> {
        let header = Header {
            version: 2,
            space,
            salt: random(),
            nonce: random(),
        };

        let key = backup_key(PASSWORD.as_bytes(), &header.salt).unwrap();

        Writer::begin(Vec::new(), &header, &key).unwrap()
    }

    fn written_within(store: &Store, space: Uuid, limit: usize) -> Result<Vec<u8>, String> {
        let mut writer = writer(space);

        writer.limit = limit;

        for id in store.backup_order(space).unwrap() {
            writer.add(store.backup_bundle(space, id).unwrap().records)?;
        }

        writer.finish()
    }

    fn written(store: &Store, space: Uuid) -> Vec<u8> {
        let mut writer = writer(space);

        for id in store.backup_order(space).unwrap() {
            let bundle = store.backup_bundle(space, id).unwrap();

            assert!(bundle.missing.is_empty());
            writer.add(bundle.records).unwrap();
            let plain = writer.take().unwrap();
            let sealed = writer.sealer.next(&plain).unwrap();

            write_part(&mut writer.out, &sealed).unwrap();
        }

        writer.finish().unwrap()
    }

    fn parts(file: &[u8]) -> Vec<&[u8]> {
        assert_eq!(&file[..8], MAGIC);
        let mut found = Vec::new();
        let mut offset = 8;

        while offset < file.len() {
            let length = u32::from_le_bytes(file[offset..offset + 4].try_into().unwrap());
            let end = offset + 4 + length as usize;

            found.push(&file[offset + 4..end]);
            offset = end;
        }

        found
    }

    fn restored(target: &mut Store, file: &[u8]) -> Result<Uuid, String> {
        let sections = parts(file);
        let (space, mut opener) = opener_for(sections[0].to_vec(), PASSWORD)?;

        target.begin_restore(space).map_err(text)?;
        let (last, earlier) = sections[1..].split_last().unwrap();

        for sealed in earlier {
            let records = records_in(&opener.next(sealed).map_err(text)?)?;

            target.restore_records(space, records).map_err(text)?;
        }

        let records = records_in(&opener.last(last).map_err(text)?)?;

        target.restore_records(space, records).map_err(text)?;
        target.finish_restore(space).map_err(text)?;

        Ok(space)
    }

    #[test]
    fn a_backup_in_many_parts_restores_pages_versions_and_files() {
        let (mut source, from) = open("source");
        let (space, ids, file) = filled(&mut source, 30);
        let backup = written(&source, space);

        assert!(parts(&backup).len() > 30);
        let (mut target, to) = open("target");

        assert_eq!(restored(&mut target, &backup).unwrap(), space);
        let page = target.get(ids[12]).unwrap().unwrap();

        assert_eq!((page.title.as_str(), page.rev), ("zwei", 2));
        assert_eq!(target.versions(ids[12]).unwrap().len(), 1);
        assert_eq!(target.spaces().unwrap().len(), 1);
        let asset = format!("asset:{space}:{file}");

        assert_eq!(target.state(&asset).unwrap().unwrap(), vec![7; 300]);

        for dir in [from, to] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn a_named_version_keeps_its_name_through_a_backup() {
        let (mut source, from) = open("source");
        let (space, ids, _) = filled(&mut source, 2);

        source.label_version(ids[1], 1, Some("Abgabe")).unwrap();
        let backup = written(&source, space);
        let (mut target, to) = open("target");

        assert_eq!(restored(&mut target, &backup).unwrap(), space);
        let labels = |id: Uuid| {
            let listed = target.versions(id).unwrap();

            listed.into_iter().map(|v| v.label).collect::<Vec<_>>()
        };

        assert_eq!(labels(ids[0]), [None]);
        assert_eq!(labels(ids[1]), [Some("Abgabe".to_string())]);

        for dir in [from, to] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn a_shortened_or_reordered_backup_leaves_nothing_behind() {
        let (mut source, from) = open("source");
        let (space, ids, _) = filled(&mut source, 6);
        let backup = written(&source, space);
        let sections = parts(&backup);
        let cut = backup.len() - sections.last().unwrap().len() - 4;
        let (mut target, to) = open("target");

        assert!(restored(&mut target, &backup[..cut]).is_err());
        target.abandon_restore(space).unwrap();
        assert!(target.get(ids[0]).unwrap().is_none());
        assert!(target.spaces().unwrap().is_empty());
        assert_eq!(restored(&mut target, &backup).unwrap(), space);
        assert!(target.begin_restore(space).is_err());

        for dir in [from, to] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn a_page_too_large_for_one_part_is_split_and_restored() {
        let (mut source, from) = open("source");
        let (space, ids, first) = filled(&mut source, 1);
        let files = [(first, 7), (Uuid::new_v4(), 8), (Uuid::new_v4(), 9)];

        for (file, fill) in &files[1..] {
            let bytes = [*fill; FILE_BYTES];

            source.store_asset(space, ids[0], *file, &bytes).unwrap();
        }

        let backup = written_within(&source, space, NARROW_PART).unwrap();
        let largest = parts(&backup)[1..].iter().map(|part| part.len()).max();

        assert!(largest.unwrap() <= NARROW_PART + PART_FRAME);
        let (mut target, to) = open("target");

        assert_eq!(restored(&mut target, &backup).unwrap(), space);
        assert_eq!(target.versions(ids[0]).unwrap().len(), 1);

        for (file, fill) in files {
            let asset = format!("asset:{space}:{file}");

            assert_eq!(target.state(&asset).unwrap().unwrap(), [fill; FILE_BYTES]);
        }

        for dir in [from, to] {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn a_record_larger_than_a_part_stops_the_export() {
        let (mut source, from) = open("source");
        let (space, ..) = filled(&mut source, 1);
        let refused = written_within(&source, space, FILE_BYTES);

        assert_eq!(refused, Err(TOO_LARGE.to_string()));
        std::fs::remove_dir_all(from).unwrap();
    }
}
