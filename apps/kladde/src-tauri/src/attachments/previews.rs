use super::{
    file_reading::{FileReadError, file_bytes},
    text_and_previews,
};

use crate::notebook::vault::Vault;
use tauri::{AppHandle, State};
use uuid::Uuid;

const MAX_FOUND_TERM: usize = 2048;

async fn attachment_bytes(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    doc: Uuid,
    file: Uuid,
) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    file_bytes(app, vault, space, doc, file)
        .await
        .map_err(FileReadError::reason)
}

type Preview = Option<(usize, String)>;

async fn rendered(render: impl FnOnce() -> Preview + Send + 'static) -> Result<Preview, String> {
    tokio::task::spawn_blocking(render)
        .await
        .map_err(|_| "File preview unavailable".into())
}

#[tauri::command]
pub async fn preview_attachment(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    doc: Uuid,
    file: Uuid,
    index: usize,
) -> Result<Preview, String> {
    let bytes = attachment_bytes(&app, &vault, space, doc, file).await?;

    rendered(move || text_and_previews::preview(&bytes, index, text_and_previews::PREVIEW_EDGE))
        .await
}

#[tauri::command]
pub async fn find_in_attachment(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    doc: Uuid,
    file: Uuid,
    index: usize,
    term: String,
) -> Result<Vec<text_and_previews::FoundBox>, String> {
    if term.trim().is_empty() || term.len() > MAX_FOUND_TERM || term.contains('\0') {
        return Err("Invalid search term".into());
    }

    let bytes = attachment_bytes(&app, &vault, space, doc, file).await?;

    tokio::task::spawn_blocking(move || text_and_previews::found_boxes(&bytes, index, &term))
        .await
        .map_err(|_| "File search unavailable".into())
}

#[tauri::command]
pub async fn attachment_thumbnail(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    doc: Uuid,
    file: Uuid,
    index: Option<usize>,
) -> Result<Preview, String> {
    let bytes = attachment_bytes(&app, &vault, space, doc, file).await?;
    let index = index.unwrap_or_default();

    rendered(move || text_and_previews::preview(&bytes, index, text_and_previews::THUMBNAIL_EDGE))
        .await
}
