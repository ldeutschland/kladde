use crate::{
    attachments::{file_reading, ipc_file_data::FileInput},
    notebook::vault::Vault,
};

use std::{
    fs::{File, OpenOptions},
    io::{ErrorKind, Write},
    ops::RangeInclusive,
    path::{Path, PathBuf},
};

use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const DOWNLOAD_LIMIT: usize = 1024 * 1024 * 1024;
const NAME_LIMIT: usize = 180;
const ATTEMPTS: u32 = 1000;
const SAVE_FAILED: &str = "File could not be saved";
const INVISIBLE: [RangeInclusive<char>; 9] = [
    '\u{AD}'..='\u{AD}',
    '\u{61C}'..='\u{61C}',
    '\u{180E}'..='\u{180E}',
    '\u{200B}'..='\u{200F}',
    '\u{2028}'..='\u{202E}',
    '\u{2060}'..='\u{206F}',
    '\u{FEFF}'..='\u{FEFF}',
    '\u{FFF9}'..='\u{FFFB}',
    '\u{E0000}'..='\u{E007F}',
];
const LAUNCHABLE: &[&str] = &[
    "applescript",
    "bash",
    "command",
    "csh",
    "fileloc",
    "inetloc",
    "jar",
    "ksh",
    "pkg",
    "py",
    "scpt",
    "sh",
    "terminal",
    "tool",
    "webloc",
    "zsh",
];

fn visible(c: char) -> char {
    if c.is_control()
        || matches!(c, '/' | '\\' | ':')
        || INVISIBLE.iter().any(|range| range.contains(&c))
    {
        '_'
    } else {
        c
    }
}

fn defused(name: &str) -> String {
    let launchable = Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| LAUNCHABLE.contains(&extension.to_ascii_lowercase().as_str()));
    if launchable {
        format!("{name}.txt")
    } else {
        name.into()
    }
}

fn clean_name(name: &str) -> String {
    let mut cleaned = String::new();

    for c in name.chars().map(visible) {
        if cleaned.len() + c.len_utf8() > NAME_LIMIT {
            break;
        }

        cleaned.push(c);
    }

    let trimmed = cleaned.trim().trim_start_matches('.');

    if trimmed.is_empty() {
        "Kladde".into()
    } else {
        defused(trimmed)
    }
}

fn numbered(name: &str, number: u32) -> String {
    if number == 0 {
        return name.into();
    }

    let path = Path::new(name);

    match (path.file_stem(), path.extension()) {
        (Some(stem), Some(extension)) => format!(
            "{} ({number}).{}",
            stem.to_string_lossy(),
            extension.to_string_lossy()
        ),
        _ => format!("{name} ({number})"),
    }
}

fn create_new(folder: &Path, name: &str) -> Result<(PathBuf, File), String> {
    for number in 0..ATTEMPTS {
        let path = folder.join(numbered(name, number));

        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return quarantined(path, file),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(SAVE_FAILED.into()),
        }
    }

    Err(SAVE_FAILED.into())
}

fn quarantined(path: PathBuf, file: File) -> Result<(PathBuf, File), String> {
    if quarantine(&path) {
        return Ok((path, file));
    }

    drop(file);
    let _ = std::fs::remove_file(&path);

    Err(SAVE_FAILED.into())
}

#[cfg(target_os = "macos")]
fn quarantine(path: &Path) -> bool {
    unsafe extern "C" {
        fn kladde_quarantine(path: *const std::ffi::c_char) -> bool;
    }

    let Some(text) = path.to_str() else {
        return false;
    };

    let Ok(text) = std::ffi::CString::new(text) else {
        return false;
    };

    unsafe { kladde_quarantine(text.as_ptr()) }
}

#[cfg(not(target_os = "macos"))]
fn quarantine(_: &Path) -> bool {
    true
}

fn write_new(folder: &Path, name: &str, data: &[u8]) -> Result<PathBuf, String> {
    let (path, mut file) = create_new(folder, name)?;

    file.write_all(data).map_err(|_| SAVE_FAILED)?;

    Ok(path)
}

const UNAVAILABLE: &str = "Downloads folder unavailable";

#[cfg(target_os = "ios")]
const SHARED_FOLDER: &str = "Kladde-Export";

#[cfg(target_os = "ios")]
fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let shared = app
        .path()
        .temp_dir()
        .map_err(|_| UNAVAILABLE)?
        .join(SHARED_FOLDER)
        .join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&shared).map_err(|_| UNAVAILABLE)?;

    Ok(shared)
}

#[cfg(not(target_os = "ios"))]
fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().download_dir().map_err(|_| UNAVAILABLE.into())
}

#[cfg(target_os = "ios")]
pub fn discard_shared(app: &AppHandle) {
    if let Ok(temp) = app.path().temp_dir() {
        let _ = std::fs::remove_dir_all(temp.join(SHARED_FOLDER));
    }
}

pub fn create(app: &AppHandle, name: &str) -> Result<(PathBuf, File), String> {
    create_new(&folder(app)?, &clean_name(name))
}

fn shown_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub fn reveal(path: &Path) {
    #[cfg(target_os = "macos")]
    reveal_in_finder(path);
    #[cfg(target_os = "ios")]
    share(path);

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    let _ = path;
}

#[cfg(target_os = "macos")]
fn reveal_in_finder(path: &Path) {
    unsafe extern "C" {
        fn kladde_reveal_in_finder(path: *const std::ffi::c_char);
    }

    if let Some(text) = path.to_str()
        && let Ok(path) = std::ffi::CString::new(text)
    {
        unsafe { kladde_reveal_in_finder(path.as_ptr()) }
    }
}

#[cfg(target_os = "ios")]
fn share(path: &Path) {
    unsafe extern "C" {
        fn kladde_share_file(path: *const std::ffi::c_char);
    }

    if let Some(text) = path.to_str()
        && let Ok(path) = std::ffi::CString::new(text)
    {
        unsafe { kladde_share_file(path.as_ptr()) }
    }
}

#[tauri::command]
pub fn save_download(app: AppHandle, name: String, data: FileInput) -> Result<String, String> {
    let data = data.bytes(DOWNLOAD_LIMIT)?;
    let path = write_new(&folder(&app)?, &clean_name(&name), &data)?;

    reveal(&path);

    Ok(shown_name(&path))
}

#[tauri::command]
pub async fn export_file(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    doc: Uuid,
    id: Uuid,
    name: String,
) -> Result<String, String> {
    let (path, file) = create(&app, &name)?;

    if let Err(problem) = file_reading::write_file(&app, &vault, space, doc, id, file).await {
        let _ = std::fs::remove_file(&path);

        return Err(problem);
    }

    reveal(&path);

    Ok(shown_name(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_cleaned_and_numbered() {
        assert_eq!(clean_name("../a/b:c.pdf"), "_a_b_c.pdf");
        assert_eq!(clean_name("  "), "Kladde");
        assert_eq!(numbered("a.pdf", 2), "a (2).pdf");
        assert_eq!(numbered("a", 1), "a (1)");
    }

    #[test]
    fn existing_files_are_not_overwritten() {
        let folder = std::env::temp_dir().join(format!("kladde-dl-{}", std::process::id()));

        std::fs::create_dir_all(&folder).unwrap();
        let first = write_new(&folder, "x.txt", b"1").unwrap();
        let second = write_new(&folder, "x.txt", b"2").unwrap();

        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), b"1");
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
