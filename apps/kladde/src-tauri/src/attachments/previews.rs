use super::{
    file_reading::{FileReadError, file_bytes},
    text_and_previews,
};

use crate::notebook::vault::Vault;
use tauri::{AppHandle, State};
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_FOUND_TERM: usize = 2048;
const PAGE_BREAK: char = '\u{c}';
const PARTIAL: &str = "partial";

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
    check_term(&term)?;
    let bytes = attachment_bytes(&app, &vault, space, doc, file).await?;

    tokio::task::spawn_blocking(move || text_and_previews::found_boxes(&bytes, index, &term))
        .await
        .map_err(|_| "File search unavailable".into())
}

fn check_term(term: &str) -> Result<(), String> {
    if term.trim().is_empty() || term.len() > MAX_FOUND_TERM || term.contains('\0') {
        return Err("Invalid search term".into());
    }

    Ok(())
}

fn indexed_text(
    app: &AppHandle,
    vault: &Vault,
    space: Uuid,
    doc: Uuid,
    file: Uuid,
) -> (Zeroizing<String>, usize) {
    let stored = vault.access(app, |store| store.attachment_words(space, doc, file));
    let Ok(Some(found)) = stored else {
        return (Zeroizing::new(String::new()), 0);
    };

    let text = Zeroizing::new(found.text);
    let pages = covered_pages(&text, &found.status);

    (text, pages)
}

fn covered_pages(text: &str, status: &str) -> usize {
    let pages = text.split(PAGE_BREAK).count();

    if status == PARTIAL {
        return pages.saturating_sub(1);
    }

    pages
}

#[tauri::command]
pub async fn find_all_in_attachment(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    doc: Uuid,
    file: Uuid,
    term: String,
) -> Result<Vec<text_and_previews::FoundMatch>, String> {
    check_term(&term)?;
    let bytes = attachment_bytes(&app, &vault, space, doc, file).await?;
    let (text, pages) = indexed_text(&app, &vault, space, doc, file);

    tokio::task::spawn_blocking(move || {
        let indexed = text_and_previews::IndexedText { text: &text, pages };

        text_and_previews::found_matches(&bytes, &term, &indexed)
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_text_vouches_only_for_its_complete_pages() {
        assert_eq!(covered_pages("eins\u{c}zwei\u{c}drei", "ready"), 3);
        assert_eq!(covered_pages("eins\u{c}zwei\u{c}dr", PARTIAL), 2);
        assert_eq!(covered_pages("", "ready"), 1);
        assert_eq!(covered_pages("ein", PARTIAL), 0);
    }

    #[test]
    fn a_search_term_is_short_visible_text_without_nul() {
        let too_long = "a".repeat(MAX_FOUND_TERM + 1);

        assert!(check_term("Betrag").is_ok());
        assert!(check_term(&"ä".repeat(MAX_FOUND_TERM / 2)).is_ok());

        for term in ["", "   ", "Bet\0rag", too_long.as_str()] {
            assert!(check_term(term).is_err(), "{term:?}");
        }
    }
}
