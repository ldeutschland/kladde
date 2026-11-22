use super::{
    encrypted_files::{asset_key, decrypt_local},
    ipc_file_data::file_response,
    relay_blobs::{download_blob, keep_fetched},
};

use crate::{notebook::vault::Vault, sync::stored_account::for_space};
use kladde_protocol::decode_attachment;
use tauri::{AppHandle, State, ipc::Response};
use uuid::Uuid;
use zeroize::Zeroizing;

const JOINED_LIMIT: usize = 256 * 1024 * 1024;

#[tauri::command]
pub async fn read_file(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    doc: Uuid,
    id: Uuid,
    binary: Option<bool>,
) -> Result<Response, String> {
    let bytes = file_bytes(&app, &vault, space, doc, id).await;

    file_response(bytes.map_err(FileReadError::reason)?.to_vec(), binary)
}

pub enum FileReadError {
    Invalid,
    Unavailable(String),
}

impl FileReadError {
    pub fn reason(self) -> String {
        match self {
            Self::Invalid => "Invalid file".into(),
            Self::Unavailable(reason) => reason,
        }
    }
}

impl From<String> for FileReadError {
    fn from(reason: String) -> Self {
        Self::Unavailable(reason)
    }
}

pub async fn file_bytes(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    doc: Uuid,
    id: Uuid,
) -> Result<Zeroizing<Vec<u8>>, FileReadError> {
    match parts_of(app, vault, space, doc, id)?.as_slice() {
        [only] => part_bytes(app, vault, space, doc, *only).await,
        parts => joined(app, vault, space, doc, parts).await,
    }
}

fn parts_of(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    doc: Uuid,
    id: Uuid,
) -> Result<Vec<Uuid>, FileReadError> {
    let stored = vault.access(app, |store| {
        Ok(store.state(&asset_key(space, id))?.is_some())
    })?;

    if stored {
        return Ok(vec![id]);
    }

    let listed = vault.access(app, |store| store.file_parts(space, doc, id));
    let parts = listed.map_err(|_| FileReadError::Invalid)?;

    Ok(parts.unwrap_or_else(|| vec![id]))
}

pub async fn write_file(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    doc: Uuid,
    id: Uuid,
    mut out: impl std::io::Write,
) -> Result<(), String> {
    for part in parts_of(app, vault, space, doc, id).map_err(FileReadError::reason)? {
        let bytes = part_bytes(app, vault, space, doc, part).await;

        out.write_all(&bytes.map_err(FileReadError::reason)?)
            .map_err(|_| "File could not be saved")?;
    }

    out.flush().map_err(|_| "File could not be saved".into())
}

async fn joined(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    doc: Uuid,
    parts: &[Uuid],
) -> Result<Zeroizing<Vec<u8>>, FileReadError> {
    let mut whole = Zeroizing::new(Vec::new());

    for part in parts {
        let bytes = part_bytes(app, vault, space, doc, *part).await?;

        if bytes.len() > JOINED_LIMIT - whole.len() {
            return Err(FileReadError::Invalid);
        }

        whole.extend_from_slice(&bytes);
    }

    Ok(whole)
}

async fn part_bytes(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    doc: Uuid,
    id: Uuid,
) -> Result<Zeroizing<Vec<u8>>, FileReadError> {
    let local = match vault.access(app, |store| store.state(&asset_key(space, id)))? {
        Some(bytes) => {
            decode_attachment(&Zeroizing::new(bytes)).map_err(|_| FileReadError::Invalid)?
        }
        None => {
            let access = for_space(vault, app, space)?;

            if access.space != space {
                return Err(FileReadError::Invalid);
            }

            let item = download_blob(
                &kladde_sync::http().map_err(|e| e.to_string())?,
                &access,
                id,
                doc,
            )
            .await?;

            keep_fetched(app, vault, &access, &item)?;

            item
        }
    };

    decrypt_local(&local, doc, id)
}
