use crate::notebook::vault::Vault;
use kladde_store::{Note, Version};
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub fn versions(app: AppHandle, vault: State<Vault>, id: Uuid) -> Result<Vec<Version>, String> {
    vault.access(&app, |store| store.versions(id))
}

#[tauri::command]
pub fn version(app: AppHandle, vault: State<Vault>, id: Uuid, rev: i64) -> Result<Note, String> {
    vault.access(&app, |store| store.version(id, rev))
}

#[tauri::command]
pub fn keep_version(
    app: AppHandle,
    vault: State<Vault>,
    id: Uuid,
    label: Option<String>,
    cause: Option<String>,
) -> Result<i64, String> {
    vault.access(&app, |store| {
        store.keep_version(id, label.as_deref(), cause.as_deref())
    })
}

#[tauri::command]
pub fn label_version(
    app: AppHandle,
    vault: State<Vault>,
    id: Uuid,
    rev: i64,
    label: Option<String>,
) -> Result<(), String> {
    vault.access(&app, |store| store.label_version(id, rev, label.as_deref()))
}

#[tauri::command]
pub fn delete_version(
    app: AppHandle,
    vault: State<Vault>,
    id: Uuid,
    rev: i64,
) -> Result<(), String> {
    vault.access(&app, |store| store.delete_version(id, rev))
}
