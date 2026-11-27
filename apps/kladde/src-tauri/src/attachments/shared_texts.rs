use super::{
    encrypted_files::{unwrap_epoch_key, wrap_file_key},
    relay_blobs::fetch_bytes,
    text_and_previews::{Extraction, TEXT_LIMIT},
};

use crate::{notebook::vault::Vault, sync::stored_account::for_space};
use ed25519_dalek::{Signer, SigningKey};
use kladde_crypto::{self as c, Wrapped, files::File};
use kladde_protocol::{Certificate, decode_attachment, encode};
use kladde_store::{AttachmentJob, ExtractedText};
use kladde_sync::account::Access;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const SHARED_STATUSES: [&str; 2] = ["ready", "partial"];
const SIGNED_TEXT: u8 = 2;
const TEXT_SIGNATURE: &[u8] = b"kladde/v1/file-text-signature";

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct SharedText {
    status: String,
    text: String,
}

#[derive(Serialize, Deserialize)]
struct SignedText {
    version: u8,
    id: Uuid,
    doc: Uuid,
    file: Uuid,
    epoch: u32,
    key: Wrapped,
    text: File,
    certificate: Certificate,
    signature: Vec<u8>,
}

impl SignedText {
    fn signed_part(&self, space: Uuid) -> Result<Vec<u8>, String> {
        encode(&(
            TEXT_SIGNATURE,
            space,
            self.version,
            self.id,
            self.doc,
            self.file,
            self.epoch,
            &self.key,
            &self.text,
        ))
        .map_err(|e| e.to_string())
    }
}

pub fn is_shared(status: &str) -> bool {
    SHARED_STATUSES.contains(&status)
}

fn marker(access: &Access) -> String {
    format!(
        "shared-text:{}:{}:{}:",
        access.account,
        access.space,
        access.epoch()
    )
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
        if !store.keep_sent(access.space, doc, id)? {
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
    let mut signed = SignedText {
        version: SIGNED_TEXT,
        id,
        doc: item.doc,
        file: item.file,
        epoch: access.epoch(),
        key: wrap_file_key(access, item.doc, id, key.as_ref())?,
        text: c::files::encrypt(&key, &plain).map_err(|e| e.to_string())?,
        certificate: access.cert.clone(),
        signature: Vec::new(),
    };

    let device = SigningKey::from_bytes(&access.device_key);

    signed.signature = device
        .sign(&signed.signed_part(access.space)?)
        .to_bytes()
        .to_vec();

    Ok((id, encode(&signed).map_err(|e| e.to_string())?))
}

fn is_current(access: &Access, signed: &SignedText, doc: Uuid, file: Uuid) -> bool {
    let epoch = access.epoch();

    signed.version == SIGNED_TEXT
        && signed.doc == doc
        && signed.file == file
        && signed.epoch == epoch
        && access.text_id(doc, file).is_ok_and(|id| id == signed.id)
}

fn opened_text(access: &Access, doc: Uuid, file: Uuid, bytes: &[u8]) -> Option<SharedText> {
    let signed: SignedText = decode_attachment(bytes).ok()?;

    if !is_current(access, &signed, doc, file) {
        return None;
    }

    let (_, identity) = access.epoch_keys(signed.epoch).ok()?;
    let message = signed.signed_part(access.space).ok()?;

    c::verify_certified(
        &identity,
        access.account,
        &signed.certificate,
        &message,
        &signed.signature,
    )
    .ok()?;
    let key = unwrap_epoch_key(access, doc, signed.id, signed.epoch, &signed.key).ok()?;
    let plain = c::files::decrypt(&key, &signed.text).ok()?;
    let shared: SharedText = decode_attachment(&plain).ok()?;

    (is_shared(&shared.status) && shared.text.len() <= TEXT_LIMIT).then_some(shared)
}

pub async fn relay_holds_valid(
    client: &reqwest::Client,
    access: &Access,
    doc: Uuid,
    file: Uuid,
) -> bool {
    let Ok(id) = access.text_id(doc, file) else {
        return false;
    };

    let Ok(bytes) = fetch_bytes(client, access, id).await else {
        return false;
    };

    opened_text(access, doc, file, &bytes).is_some()
}

pub async fn received_text(
    app: &AppHandle,
    vault: &Vault,
    job: &AttachmentJob,
) -> Option<Extraction> {
    let access = for_space(vault, app, job.space).ok()?;
    let id = access.text_id(job.doc, job.file).ok()?;
    let client = kladde_sync::http().ok()?;
    let bytes = fetch_bytes(&client, &access, id).await.ok()?;
    let mut shared = opened_text(&access, job.doc, job.file, &bytes)?;
    let status = SHARED_STATUSES
        .into_iter()
        .find(|known| *known == shared.status)?;

    mark_shared(app, vault, &access, job.file).ok()?;

    Some(Extraction::new(status, std::mem::take(&mut shared.text)))
}
