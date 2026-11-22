use crate::notebook::vault::Vault;
use kladde_store::{Attachment, Passage};
use std::time::Duration;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub fn list_attachments(
    app: AppHandle,
    vault: State<Vault>,
    space: Uuid,
    doc: Uuid,
    offset: u32,
) -> Result<Vec<Attachment>, String> {
    vault.access(&app, |store| store.attachments(space, doc, offset))
}

#[tauri::command]
pub async fn read_attachment(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    doc: Uuid,
    file: Uuid,
    offset: u32,
    wait: Option<bool>,
) -> Result<Passage, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);

    loop {
        let passage = vault.access(&app, |store| {
            store.attachment_text(space, doc, file, offset)
        })?;

        if wait != Some(true)
            || passage.status != "pending"
            || tokio::time::Instant::now() >= deadline
        {
            return Ok(passage);
        }

        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}
