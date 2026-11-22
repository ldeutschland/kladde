use super::{
    encrypted_files::{Blob, Local, decrypt_local, store_locally, unwrap_file_key},
    uploads::upload_marker,
};

use crate::{notebook::vault::Vault, sync::stored_account::for_space};
use kladde_protocol::{MAX_ENCODED_ATTACHMENT, decode_attachment, encode};
use kladde_sync::account::Access;
use std::time::Duration;
use tauri::AppHandle;
use uuid::Uuid;

const TRANSFER_START: Duration = Duration::from_secs(30);
const SLOWEST_BYTES_PER_SECOND: usize = 32 * 1024;
const STALL_LIMIT: Duration = Duration::from_secs(30);

pub fn transfer_time(bytes: usize) -> Duration {
    TRANSFER_START + Duration::from_secs((bytes / SLOWEST_BYTES_PER_SECOND) as u64)
}

pub fn endpoint(access: &Access, id: Uuid) -> Result<url::Url, String> {
    kladde_sync::Origin::parse(&access.origin)
        .map_err(|e| e.to_string())?
        .0
        .join(&format!("v1/spaces/{}/blobs/{id}", access.space))
        .map_err(|_| "Invalid sync address".into())
}

pub fn keep_fetched(
    app: &AppHandle,
    vault: &Vault,
    access: &Access,
    item: &Local,
) -> Result<(), String> {
    store_locally(app, vault, access.space, item)?;

    vault.access(app, |store| {
        store.set_state(&upload_marker(access, &item.id.to_string()), &[1])
    })
}

pub async fn download_blob(
    client: &reqwest::Client,
    access: &Access,
    id: Uuid,
    doc: Uuid,
) -> Result<Local, String> {
    use futures_util::StreamExt;

    let response = client
        .get(endpoint(access, id)?)
        .bearer_auth(&access.token)
        .timeout(transfer_time(MAX_ENCODED_ATTACHMENT))
        .send()
        .await
        .map_err(|_| "Download failed")?
        .error_for_status()
        .map_err(|_| "Download denied")?;
    let mut stream = response.bytes_stream();
    let mut bytes = vec![];

    while let Some(c) = tokio::time::timeout(STALL_LIMIT, stream.next())
        .await
        .map_err(|_| "Download failed")?
    {
        let c = c.map_err(|_| "Download failed")?;

        if c.len() > MAX_ENCODED_ATTACHMENT - bytes.len() {
            return Err("Blob too large".into());
        }

        bytes.extend(c)
    }

    let blob: Blob = decode_attachment(&bytes).map_err(|_| "Invalid blob")?;

    if blob.id != id || blob.doc != doc || blob.version != 1 {
        return Err("Invalid blob context".into());
    }

    let key = unwrap_file_key(access, doc, id, &blob.key)?;
    let local = Local {
        version: 1,
        id,
        doc,
        key: key.as_slice().try_into().map_err(|_| "Invalid file key")?,
        file: blob.file,
        uploaded: true,
    };

    decrypt_local(&local, doc, id).map_err(|_| "Invalid blob")?;

    Ok(local)
}

pub async fn fetch_for_backup(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    doc: Uuid,
    id: Uuid,
) -> Result<kladde_store::Record, String> {
    let account = for_space(vault, app, space)
        .map_err(|_| "Backup needs the sync connection to retrieve missing attachments")?;
    let client = kladde_sync::http().map_err(|e| e.to_string())?;
    let local = download_blob(&client, &account, id, doc).await?;
    let bytes = encode(&local).map_err(|_| "Invalid attachment")?;

    keep_fetched(app, vault, &account, &local)?;

    Ok(kladde_store::Record::File { id, doc, bytes })
}
