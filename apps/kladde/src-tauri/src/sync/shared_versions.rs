use crate::{
    attachments::{
        encrypted_files,
        file_reading::{FileReadError, file_bytes},
    },
    notebook::vault::Vault,
    sync::stored_account::for_space,
};

use kladde_store::{Note, Shares};
use tauri::{AppHandle, State};
use uuid::Uuid;
use zeroize::Zeroizing;

#[tauri::command]
pub fn share_versions(
    app: AppHandle,
    vault: State<Vault>,
    space: Uuid,
    doc: Uuid,
) -> Result<Shares, String> {
    if for_space(&vault, &app, space).is_err() {
        return Ok(Shares::default());
    }

    let waiting = vault.access(&app, |store| store.unshared_versions(space, doc))?;

    for (rev, record) in waiting {
        let record = Zeroizing::new(record);
        let file = encrypted_files::store_new(&app, &vault, space, doc, &record)?;

        vault.access(&app, |store| store.mark_shared(doc, rev, file))?;
    }

    vault.access(&app, |store| store.reconcile_shared(space, doc))
}

async fn open_shared_version(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    doc: Uuid,
    file: Uuid,
) -> Result<Note, String> {
    let record = file_bytes(app, vault, space, doc, file)
        .await
        .map_err(FileReadError::reason)?;
    vault.access(app, |store| store.shared_version(space, doc, file, &record))
}

#[tauri::command]
pub async fn shared_version(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    doc: Uuid,
    file: Uuid,
) -> Result<Note, String> {
    open_shared_version(&app, &vault, space, doc, file).await
}

#[tauri::command]
pub async fn drop_shared_version(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    doc: Uuid,
    file: Uuid,
) -> Result<(), String> {
    if !vault.access(&app, |store| store.knows_shared(doc, file))? {
        open_shared_version(&app, &vault, space, doc, file).await?;
    }

    vault.access(&app, |store| store.erase_shared(space, doc, file))
}
