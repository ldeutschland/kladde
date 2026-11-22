use super::{
    file_reading::{FileReadError, file_bytes},
    text_and_previews,
};

use crate::notebook::vault::Vault;
use kladde_store::SearchHit;
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

pub async fn index_files(app: AppHandle) {
    WORK.notified().await;
    let vault = app.state::<Vault>();

    loop {
        while let Ok(Some(job)) = vault.access(&app, |store| store.next_attachment()) {
            let name = job.name.clone();

            if plays_media(&name) {
                let skipped = vault.access(&app, |store| {
                    store.finish_attachment(&job, "unsupported", "")
                });

                if skipped.is_err() {
                    break;
                }

                continue;
            }

            let extracted = match file_bytes(&app, &vault, job.space, job.doc, job.file).await {
                Ok(bytes) => {
                    tokio::task::spawn_blocking(move || text_and_previews::extract(&bytes, &name))
                        .await
                        .ok()
                }
                Err(FileReadError::Invalid) => None,
                Err(FileReadError::Unavailable(_)) => {
                    if vault
                        .access(&app, |store| store.defer_attachment(&job))
                        .is_err()
                    {
                        break;
                    }

                    continue;
                }
            };

            let saved = vault.access(&app, |store| match extracted {
                Some(result) => store.finish_attachment(&job, result.status, &result.text),
                None => store.finish_attachment(&job, "unreadable", ""),
            });

            if saved.is_err() {
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
