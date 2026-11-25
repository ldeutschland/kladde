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

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct SharedText {
    status: String,
    text: String,
}

pub fn is_shared(status: &str) -> bool {
    SHARED_STATUSES.contains(&status)
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

pub fn mark_uploaded(
    app: &AppHandle,
    vault: &Vault,
    access: &Access,
    doc: Uuid,
    file: Uuid,
    id: Uuid,
) -> Result<(), String> {
    let marker = format!("{}{file}", marker(access));

    vault.access(app, |store| {
        if store.erase_if_orphaned(access.space, doc, id)? {
            return Ok(());
        }

        store.set_state(&marker, &[1])
    })
}

pub fn sealed_text(access: &Access, item: ExtractedText) -> Result<(Uuid, Vec<u8>), String> {
    let id = access
        .text_id(item.doc, item.file)
        .map_err(|e| e.to_string())?;
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

pub async fn received_text(
    app: &AppHandle,
    vault: &Vault,
    job: &AttachmentJob,
) -> Option<Extraction> {
    let access = for_space(vault, app, job.space).ok()?;
    let id = access.text_id(job.doc, job.file).ok()?;
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
