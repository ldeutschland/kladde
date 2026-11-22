use crate::{attachments::search_index, notebook::vault::Vault};
use kladde_store::Note;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub fn spaces(app: AppHandle, vault: State<Vault>) -> Result<Vec<(Uuid, String)>, String> {
    vault.access(&app, |store| store.spaces())
}

#[tauri::command]
pub fn load(app: AppHandle, vault: State<Vault>, id: Uuid) -> Result<Option<Note>, String> {
    vault.access(&app, |store| store.get(id))
}

#[tauri::command]
pub fn load_manifest(
    app: AppHandle,
    vault: State<Vault>,
    id: Uuid,
) -> Result<tauri::ipc::Response, String> {
    let note = workspace_note(&app, &vault, id)?;

    search_index::wake();

    Ok(with_revision_prefix(note.rev, &note.data))
}

fn workspace_note(app: &AppHandle, vault: &Vault, id: Uuid) -> Result<Note, String> {
    let note = vault
        .access(app, |store| store.get(id))?
        .ok_or("Unknown notebook")?;

    if note.kind != "workspace" || note.space != id {
        return Err("Invalid notebook".into());
    }

    Ok(note)
}

const OPENED_SPACE: &str = "opened";

#[tauri::command]
pub fn opened_space(app: AppHandle, vault: State<Vault>) -> Result<Option<Uuid>, String> {
    let stored = vault.access(&app, |store| store.state(OPENED_SPACE))?;

    Ok(stored.and_then(|bytes| Uuid::from_slice(&bytes).ok()))
}

#[tauri::command]
pub fn remember_space(app: AppHandle, vault: State<Vault>, id: Uuid) -> Result<(), String> {
    workspace_note(&app, &vault, id)?;

    vault.access(&app, |store| store.set_state(OPENED_SPACE, id.as_bytes()))
}

fn with_revision_prefix(rev: i64, data: &[u8]) -> tauri::ipc::Response {
    let mut bytes = Vec::with_capacity(data.len() + 8);

    bytes.extend_from_slice(&rev.to_le_bytes());
    bytes.extend_from_slice(data);

    tauri::ipc::Response::new(bytes)
}

#[tauri::command]
pub fn load_state(
    app: AppHandle,
    vault: State<Vault>,
    id: Uuid,
    space: Uuid,
    kind: String,
    after: i64,
) -> Result<tauri::ipc::Response, String> {
    let found = vault.access(&app, |store| {
        let Some((owner, stored, rev)) = store.revision(id)? else {
            return Ok(None);
        };

        if owner != space || stored != kind {
            return Ok(None);
        }

        if rev <= after {
            return Ok(Some((rev, None)));
        }

        Ok(store.get(id)?.map(|note| (note.rev, Some(note.data))))
    })?;

    Ok(match found {
        None => tauri::ipc::Response::new(Vec::new()),
        Some((rev, data)) => with_revision_prefix(rev, data.as_deref().unwrap_or_default()),
    })
}

#[tauri::command]
pub fn save(app: AppHandle, vault: State<Vault>, notes: Vec<Note>) -> Result<(), String> {
    vault.access(&app, |store| store.save(&notes, false))?;
    search_index::wake();

    Ok(())
}

#[tauri::command]
pub fn search(
    app: AppHandle,
    vault: State<Vault>,
    space: Uuid,
    query: String,
) -> Result<Vec<Uuid>, String> {
    vault.access(&app, |store| store.search(space, &query))
}

#[tauri::command]
pub fn backlinks(app: AppHandle, vault: State<Vault>, id: Uuid) -> Result<Vec<Uuid>, String> {
    vault.access(&app, |store| store.backlinks(id))
}

#[tauri::command]
pub fn forget(app: AppHandle, vault: State<Vault>, id: Uuid) -> Result<(), String> {
    vault.access(&app, |store| store.forget(id))
}
