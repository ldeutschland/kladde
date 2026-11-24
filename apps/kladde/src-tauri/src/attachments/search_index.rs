use super::{
    file_reading::{FileReadError, file_bytes, keep_offline},
    text_and_previews::{self, Extraction},
};

use crate::notebook::vault::Vault;
use kladde_store::{AttachmentJob, SearchHit, Store};
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Notify;
use uuid::Uuid;

static WORK: Notify = Notify::const_new();

pub fn wake() {
    WORK.notify_one();
}

const MEDIA_SUFFIXES: [&str; 14] = [
    ".m4a", ".mp3", ".wav", ".aac", ".ogg", ".oga", ".flac", ".caf", ".mp4", ".m4v", ".mov",
    ".webm", ".mkv", ".avi",
];

fn plays_media(name: &str) -> bool {
    let name = name.to_lowercase();

    MEDIA_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

enum Indexed {
    Extracted(Extraction),
    KeptOffline,
    Unreadable,
    Unavailable,
}

async fn index_media(app: &AppHandle, vault: &Vault, job: &AttachmentJob) -> Indexed {
    match keep_offline(app, vault, job.space, job.doc, job.file).await {
        Ok(()) => Indexed::KeptOffline,
        Err(FileReadError::Invalid) => Indexed::Unreadable,
        Err(FileReadError::Unavailable(_)) => Indexed::Unavailable,
    }
}

async fn index_text(app: &AppHandle, vault: &Vault, job: &AttachmentJob) -> Indexed {
    let name = job.name.clone();

    match file_bytes(app, vault, job.space, job.doc, job.file).await {
        Ok(bytes) => {
            let extracted =
                tokio::task::spawn_blocking(move || text_and_previews::extract(&bytes, &name));

            extracted
                .await
                .map_or(Indexed::Unreadable, Indexed::Extracted)
        }
        Err(FileReadError::Invalid) => Indexed::Unreadable,
        Err(FileReadError::Unavailable(_)) => Indexed::Unavailable,
    }
}

fn record(
    store: &mut Store,
    job: &AttachmentJob,
    indexed: Indexed,
) -> Result<(), kladde_store::Error> {
    match indexed {
        Indexed::Extracted(result) => store.finish_attachment(job, result.status, &result.text),
        Indexed::KeptOffline => store.finish_attachment(job, "unsupported", ""),
        Indexed::Unreadable => store.finish_attachment(job, "unreadable", ""),
        Indexed::Unavailable => store.defer_attachment(job),
    }
}

pub async fn index_files(app: AppHandle) {
    WORK.notified().await;
    let vault = app.state::<Vault>();

    loop {
        while let Ok(Some(job)) = vault.access(&app, |store| store.next_attachment()) {
            let indexed = if plays_media(&job.name) {
                index_media(&app, &vault, &job).await
            } else {
                index_text(&app, &vault, &job).await
            };

            if vault
                .access(&app, |store| record(store, &job, indexed))
                .is_err()
            {
                break;
            }
        }

        tokio::select! {
            _ = WORK.notified() => {}
            _ = tokio::time::sleep(Duration::from_secs(60)) => {}
        }
    }
}

#[derive(Serialize)]
pub struct SearchResults {
    hits: Vec<SearchHit>,
    pending: u32,
}

#[tauri::command]
pub fn search_content(
    app: AppHandle,
    vault: State<Vault>,
    space: Uuid,
    query: String,
    parent: Option<Uuid>,
) -> Result<SearchResults, String> {
    vault.access(&app, |store| {
        Ok(SearchResults {
            hits: store.search_content(space, &query, parent)?,
            pending: store.pending_attachments(space)?,
        })
    })
}
