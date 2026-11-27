use super::{file_reading::FileReadError, ipc_file_data::FileInput};
use crate::notebook::vault::Vault;
use kladde_crypto::{self as c, Purpose, Wrapped, files::File};
use kladde_protocol::{MAX_ATTACHMENT_BYTES, decode_attachment, encode};
use kladde_store::Hash;
use kladde_sync::account::Access;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
pub struct Local {
    pub(super) version: u8,
    pub(super) id: Uuid,
    pub(super) doc: Uuid,
    pub(super) key: [u8; 32],
    pub(super) file: File,
    pub(super) uploaded: bool,
}

impl Drop for Local {
    fn drop(&mut self) {
        use zeroize::Zeroize;

        self.key.zeroize()
    }
}

#[derive(Serialize, Deserialize)]
pub struct Blob {
    pub(super) version: u8,
    pub(super) id: Uuid,
    pub(super) doc: Uuid,
    pub(super) key: Wrapped,
    pub(super) file: File,
}

pub const FILE_PART_BYTES: usize = 8 * 1024 * 1024;

pub fn asset_key(space: Uuid, id: Uuid) -> String {
    format!("asset:{space}:{id}")
}

pub fn content_hash(data: &[u8]) -> Hash {
    Sha256::digest(data).into()
}

pub fn store_locally(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    item: &Local,
) -> Result<(), String> {
    let value = Zeroizing::new(encode(item).map_err(|e| e.to_string())?);

    vault.access(app, |store| {
        store.store_asset(space, item.doc, item.id, &value)
    })
}

fn doc_key(access: &Access, doc: Uuid, epoch: u32) -> Result<c::Key, String> {
    let (workspace, _) = access.epoch_keys(epoch).map_err(|e| e.to_string())?;

    c::derive(workspace.as_ref(), doc.as_bytes(), b"kladde/v1/doc").map_err(|e| e.to_string())
}

pub fn wrap_file_key(access: &Access, doc: Uuid, id: Uuid, key: &[u8]) -> Result<Wrapped, String> {
    let doc_key = doc_key(access, doc, access.epoch())?;

    c::wrap(doc_key.as_ref(), id, Purpose::File, key).map_err(|e| e.to_string())
}

pub fn unwrap_epoch_key(
    access: &Access,
    doc: Uuid,
    id: Uuid,
    epoch: u32,
    wrapped: &Wrapped,
) -> Result<c::Key, String> {
    let doc_key = doc_key(access, doc, epoch)?;
    let key = c::unwrap(doc_key.as_ref(), id, Purpose::File, wrapped).map_err(|e| e.to_string())?;

    Ok(Zeroizing::new(
        key.as_slice().try_into().map_err(|_| "Invalid file key")?,
    ))
}

pub fn unwrap_file_key(
    access: &Access,
    doc: Uuid,
    id: Uuid,
    wrapped: &Wrapped,
) -> Result<c::Key, String> {
    (1..=access.epoch())
        .rev()
        .find_map(|epoch| unwrap_epoch_key(access, doc, id, epoch, wrapped).ok())
        .ok_or_else(|| "Invalid file key".into())
}

#[tauri::command]
pub fn add_file(
    app: AppHandle,
    vault: State<Vault>,
    space: Uuid,
    doc: Uuid,
    data: FileInput,
) -> Result<Uuid, String> {
    let data = data.bytes(MAX_ATTACHMENT_BYTES)?;

    store_new(&app, &vault, space, doc, &data)
}

#[derive(Default, Serialize)]
pub struct Saved {
    pub parts: Vec<Uuid>,
    pub sha256: Vec<String>,
    pub size: u64,
}

pub fn store_parts(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    doc: Uuid,
    source: &mut impl std::io::Read,
) -> Result<Saved, String> {
    use std::io::Read;

    let mut saved = Saved::default();

    loop {
        let mut part = Zeroizing::new(Vec::new());

        source
            .by_ref()
            .take(FILE_PART_BYTES as u64)
            .read_to_end(&mut part)
            .map_err(|_| "File could not be read")?;
        if part.is_empty() {
            return Ok(saved);
        }

        if saved.parts.len() == kladde_store::MAX_FILE_PARTS {
            return Err("File has too many parts".into());
        }

        saved.size += part.len() as u64;
        saved.sha256.push(hex::encode(content_hash(&part)));
        saved.parts.push(store_new(app, vault, space, doc, &part)?);
    }
}

pub fn store_new(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    doc: Uuid,
    data: &[u8],
) -> Result<Uuid, String> {
    let id = Uuid::new_v4();
    let key = c::key();
    let file = c::files::encrypt(&key, data).map_err(|e| e.to_string())?;

    store_locally(
        app,
        vault,
        space,
        &Local {
            version: 1,
            id,
            doc,
            key: *key,
            file,
            uploaded: false,
        },
    )?;

    Ok(id)
}

pub fn seal_for_upload(access: &Access, local: &Local) -> Result<Vec<u8>, String> {
    let blob = Blob {
        version: 1,
        id: local.id,
        doc: local.doc,
        key: wrap_file_key(access, local.doc, local.id, &local.key)?,
        file: local.file.clone(),
    };

    encode(&blob).map_err(|e| e.to_string())
}

pub fn decrypt_local(
    local: &Local,
    doc: Uuid,
    id: Uuid,
) -> Result<Zeroizing<Vec<u8>>, FileReadError> {
    if local.id != id || local.doc != doc || local.version != 1 {
        return Err(FileReadError::Invalid);
    }

    let bytes = c::files::decrypt(&Zeroizing::new(local.key), &local.file)
        .map_err(|_| FileReadError::Invalid)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(FileReadError::Invalid);
    }

    Ok(bytes)
}

pub fn is_intact(bytes: &[u8], doc: Uuid, id: Uuid) -> bool {
    decode_attachment(bytes).is_ok_and(|local: Local| decrypt_local(&local, doc, id).is_ok())
}
