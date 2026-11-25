use super::{
    encrypted_files::{Local, decrypt_local, seal_for_upload},
    relay_blobs::download_blob,
    text_and_previews::{Extraction, TEXT_LIMIT},
};

use crate::{notebook::vault::Vault, sync::stored_account::for_space};
use kladde_crypto as c;
use kladde_protocol::{decode_attachment, encode};
use kladde_store::{AttachmentJob, ExtractedText};
use kladde_sync::account::Access;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const SHARED_STATUSES: [&str; 2] = ["ready", "partial"];
const TEXT_ID_PURPOSE: &[u8] = b"kladde/v1/file-text";
const FIRST_EPOCH: u32 = 1;

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct SharedText {
    status: String,
    text: String,
}

pub fn is_shared(status: &str) -> bool {
    SHARED_STATUSES.contains(&status)
}

fn text_id(access: &Access, doc: Uuid, file: Uuid) -> Result<Uuid, String> {
    let (first, _) = access.epoch_keys(FIRST_EPOCH).map_err(|e| e.to_string())?;
    let context = [doc.as_bytes().as_slice(), file.as_bytes().as_slice()].concat();
    let derived =
        c::derive(first.as_ref(), &context, TEXT_ID_PURPOSE).map_err(|e| e.to_string())?;
    let mut bytes = [0u8; 16];

    bytes.copy_from_slice(&derived[..16]);

    Ok(uuid::Builder::from_random_bytes(bytes).into_uuid())
}

fn marker(access: &Access) -> String {
    format!("shared-text:{}:{}:", access.account, access.space)
}

pub fn next_unshared(
    app: &AppHandle,
    vault: &Vault,
    access: &Access,
) -> Result<Option<ExtractedText>, String> {
    let marker = marker(access);

    vault.access(app, |store| store.next_unshared_text(access.space, &marker))
}

pub fn mark_shared(
    app: &AppHandle,
    vault: &Vault,
    access: &Access,
    file: Uuid,
) -> Result<(), String> {
    let marker = format!("{}{file}", marker(access));

    vault.access(app, |store| store.set_state(&marker, &[1]))
}

pub fn sealed_text(access: &Access, item: ExtractedText) -> Result<(Uuid, Vec<u8>), String> {
    let id = text_id(access, item.doc, item.file)?;
    let shared = SharedText {
        status: item.status,
        text: item.text,
    };

    let plain = Zeroizing::new(encode(&shared).map_err(|e| e.to_string())?);
    let key = c::key();
    let file = c::files::encrypt(&key, &plain).map_err(|e| e.to_string())?;
    let local = Local {
        version: 1,
        id,
        doc: item.doc,
        key: *key,
        file,
        uploaded: false,
    };

    Ok((id, seal_for_upload(access, &local)?))
}

pub fn text_ids_of(app: &AppHandle, vault: &Vault, doc: Uuid) -> Result<Vec<Uuid>, String> {
    let Some((space, _, _)) = vault.access(app, |store| store.revision(doc))? else {
        return Ok(Vec::new());
    };

    let Ok(access) = for_space(vault, app, space) else {
        return Ok(Vec::new());
    };

    vault
        .access(app, |store| store.attached_files(doc))?
        .into_iter()
        .map(|(owner, file)| text_id(&access, owner, file))
        .collect()
}

pub async fn received_text(
    app: &AppHandle,
    vault: &Vault,
    job: &AttachmentJob,
) -> Option<Extraction> {
    let access = for_space(vault, app, job.space).ok()?;
    let id = text_id(&access, job.doc, job.file).ok()?;
    let client = kladde_sync::http().ok()?;
    let local = download_blob(&client, &access, id, job.doc).await.ok()?;
    let plain = decrypt_local(&local, job.doc, id).ok()?;
    let mut shared: SharedText = decode_attachment(&plain).ok()?;
    let status = SHARED_STATUSES
        .into_iter()
        .find(|known| *known == shared.status)?;

    if shared.text.len() > TEXT_LIMIT {
        return None;
    }

    mark_shared(app, vault, &access, job.file).ok()?;

    Some(Extraction::new(status, std::mem::take(&mut shared.text)))
}
