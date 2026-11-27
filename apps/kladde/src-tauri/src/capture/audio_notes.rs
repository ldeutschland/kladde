use crate::{
    attachments::{
        encrypted_files::{self, Saved},
        file_reading,
    },
    notebook::vault::Vault,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    ffi::{CStr, CString, c_char},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;
use uuid::Uuid;

type Notice = extern "C" fn(*const c_char);

unsafe extern "C" {
    fn kladde_audio_start(
        path: *const c_char,
        language: *const c_char,
        generation: u64,
        notice: Notice,
    ) -> bool;

    fn kladde_audio_pause();

    fn kladde_audio_resume();

    fn kladde_audio_stop(language: *const c_char) -> bool;

    fn kladde_audio_transcribe(path: *const c_char, language: *const c_char, notice: Notice);

    fn kladde_audio_languages(notice: Notice);
}

const FOLDER: &str = "recordings";
const RECORDING_EVENT: &str = "audio";
const TRANSCRIPT_EVENT: &str = "audio-transcript";
const FINISH_LIMIT: Duration = Duration::from_secs(60 * 60);
const LANGUAGE_LIMIT: Duration = Duration::from_secs(20);
const MAX_LANGUAGE: usize = 35;
const MAX_LANGUAGES: usize = 400;
const MAX_SUFFIX: usize = 5;
const DEFAULT_SUFFIX: &str = "m4a";
const BUSY: &str = "Audio is busy";
const DISCARDED: &str = "Recording discarded";

static APP: OnceLock<AppHandle> = OnceLock::new();

#[derive(Clone, Debug, Serialize)]
pub struct Outcome {
    seconds: f64,
    text: String,
    transcribed: bool,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredAudio {
    space: Uuid,
    doc: Uuid,
    id: Uuid,
    name: String,
    language: String,
}

type Waiting<T> = Option<oneshot::Sender<Result<T, String>>>;

#[derive(Default)]
struct Desk {
    file: Option<PathBuf>,
    active: bool,
    generation: u64,
    finishing: Waiting<Outcome>,
    transcribing: Waiting<Outcome>,
    languages: Waiting<Vec<String>>,
}

#[derive(Default)]
pub struct Recorder(Mutex<Desk>);

impl Recorder {
    fn desk(&self) -> Result<std::sync::MutexGuard<'_, Desk>, String> {
        self.0.lock().map_err(|_| "Audio unavailable".into())
    }
}

impl Desk {
    fn next_generation(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);

        self.generation
    }

    fn abandon_finishing(&mut self) {
        if let Some(waiting) = self.finishing.take() {
            let _ = waiting.send(Err(DISCARDED.into()));
        }
    }
}

pub fn start(app: AppHandle) {
    if let Ok(folder) = folder(&app) {
        let _ = std::fs::remove_dir_all(folder);
    }

    let _ = APP.set(app);
}

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let cache = app.path().app_cache_dir();

    Ok(cache.map_err(|_| "Audio unavailable")?.join(FOLDER))
}

fn private_folder(app: &AppHandle) -> Result<PathBuf, String> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    let folder = folder(app)?;

    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&folder)
        .map_err(|_| "Audio unavailable")?;
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| "Audio unavailable")?;
    Ok(folder)
}

fn language_tag(language: &str) -> Result<CString, String> {
    let plain = !language.is_empty()
        && language.len() <= MAX_LANGUAGE
        && language
            .split('-')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric()));
    if !plain {
        return Err("Invalid language".into());
    }

    CString::new(language).map_err(|_| "Invalid language".into())
}

fn c_path(path: &Path) -> Result<CString, String> {
    let text = path.to_str().ok_or("Audio unavailable")?;

    CString::new(text).map_err(|_| "Audio unavailable".into())
}

fn parsed(text: *const c_char) -> Option<Value> {
    if text.is_null() {
        return None;
    }

    let text = unsafe { CStr::from_ptr(text) }.to_str().ok()?;

    serde_json::from_str(text).ok()
}

fn outcome(event: &Value) -> Option<Result<Outcome, String>> {
    match event["kind"].as_str()? {
        "done" => Some(Ok(Outcome {
            seconds: event["seconds"].as_f64().unwrap_or_default(),
            text: event["text"].as_str().unwrap_or_default().to_owned(),
            transcribed: event["transcribed"].as_bool().unwrap_or_default(),
            reason: event["reason"].as_str().unwrap_or_default().to_owned(),
        })),
        "failed" => Some(Err(event["reason"]
            .as_str()
            .unwrap_or("Audio failed")
            .to_owned())),
        _ => None,
    }
}

extern "C" fn recording_notice(text: *const c_char) {
    let (Some(event), Some(app)) = (parsed(text), APP.get()) else {
        return;
    };

    if accept_recording_event(app, &event) {
        let _ = app.emit(RECORDING_EVENT, &event);
    }
}

fn accept_recording_event(app: &AppHandle, event: &Value) -> bool {
    let recorder = app.state::<Recorder>();
    let Ok(mut desk) = recorder.desk() else {
        return false;
    };

    current_event(&mut desk, event)
}

fn current_event(desk: &mut Desk, event: &Value) -> bool {
    if event["generation"].as_u64() != Some(desk.generation) {
        return false;
    }

    if let Some(result) = outcome(event) {
        settle_recording(desk, result);
    }

    true
}

fn settle_recording(desk: &mut Desk, result: Result<Outcome, String>) {
    desk.active = false;

    if result.is_err()
        && let Some(file) = desk.file.take()
    {
        let _ = std::fs::remove_file(file);
    }

    if let Some(waiting) = desk.finishing.take() {
        let _ = waiting.send(result);
    }
}

extern "C" fn transcript_notice(text: *const c_char) {
    let (Some(event), Some(app)) = (parsed(text), APP.get()) else {
        return;
    };

    let Some(result) = outcome(&event) else {
        let _ = app.emit(TRANSCRIPT_EVENT, &event);

        return;
    };

    let recorder = app.state::<Recorder>();

    if let Ok(mut desk) = recorder.desk()
        && let Some(waiting) = desk.transcribing.take()
    {
        let _ = waiting.send(result);
    }
}

extern "C" fn languages_notice(text: *const c_char) {
    let (Some(event), Some(app)) = (parsed(text), APP.get()) else {
        return;
    };

    let ids: Vec<String> = event["ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|id| id.as_str())
        .filter(|id| language_tag(id).is_ok())
        .take(MAX_LANGUAGES)
        .map(str::to_owned)
        .collect();
    let recorder = app.state::<Recorder>();

    if let Ok(mut desk) = recorder.desk()
        && let Some(waiting) = desk.languages.take()
    {
        let _ = waiting.send(Ok(ids));
    }
}

#[tauri::command]
pub fn audio_start(
    app: AppHandle,
    recorder: State<Recorder>,
    language: String,
) -> Result<(), String> {
    let language = language_tag(&language)?;
    let mut desk = recorder.desk()?;

    if desk.active || desk.finishing.is_some() {
        return Err(BUSY.into());
    }

    if let Some(stale) = desk.file.take() {
        let _ = std::fs::remove_file(stale);
    }

    let file = private_folder(&app)?.join(format!("{}.{DEFAULT_SUFFIX}", Uuid::new_v4()));
    let path = c_path(&file)?;
    let generation = desk.next_generation();
    let started = unsafe {
        kladde_audio_start(
            path.as_ptr(),
            language.as_ptr(),
            generation,
            recording_notice,
        )
    };

    if !started {
        return Err(BUSY.into());
    }

    desk.file = Some(file);
    desk.active = true;

    Ok(())
}

#[tauri::command]
pub fn audio_pause() {
    unsafe { kladde_audio_pause() }
}

#[tauri::command]
pub fn audio_resume() {
    unsafe { kladde_audio_resume() }
}

#[tauri::command]
pub async fn audio_stop(
    recorder: State<'_, Recorder>,
    language: String,
) -> Result<Outcome, String> {
    let language = language_tag(&language)?;
    let (sender, finished) = oneshot::channel();

    {
        let mut desk = recorder.desk()?;

        if !desk.active || desk.finishing.is_some() {
            return Err("No recording".into());
        }

        if !unsafe { kladde_audio_stop(language.as_ptr()) } {
            desk.active = false;

            return Err("No recording".into());
        }

        desk.finishing = Some(sender);
    }

    match tokio::time::timeout(FINISH_LIMIT, finished).await {
        Ok(Ok(result)) => result,
        _ => {
            if let Ok(mut desk) = recorder.desk() {
                desk.next_generation();
                desk.active = false;
                desk.finishing = None;
            }

            Err("Recording could not be finished".into())
        }
    }
}

#[tauri::command]
pub fn audio_discard(recorder: State<Recorder>) -> Result<(), String> {
    let mut desk = recorder.desk()?;

    if desk.active && desk.finishing.is_none() {
        unsafe { kladde_audio_stop(std::ptr::null()) };
    }

    desk.next_generation();
    desk.active = false;
    desk.abandon_finishing();

    if let Some(file) = desk.file.take() {
        let _ = std::fs::remove_file(file);
    }

    Ok(())
}

#[tauri::command]
pub async fn audio_save(
    app: AppHandle,
    recorder: State<'_, Recorder>,
    space: Uuid,
    doc: Uuid,
) -> Result<Saved, String> {
    let file = {
        let mut desk = recorder.desk()?;

        if desk.active || desk.finishing.is_some() {
            return Err(BUSY.into());
        }

        desk.file.take().ok_or("No recording")?
    };

    let stored = tauri::async_runtime::spawn_blocking(move || {
        let saved = stored_recording(&app, space, doc, &file);
        let _ = std::fs::remove_file(&file);

        saved
    });

    stored.await.map_err(|_| "Recording could not be saved")?
}

fn stored_recording(app: &AppHandle, space: Uuid, doc: Uuid, file: &Path) -> Result<Saved, String> {
    let mut source = std::fs::File::open(file).map_err(|_| "Recording could not be read")?;
    let vault = app.state::<Vault>();
    let saved = encrypted_files::store_parts(app, &vault, space, doc, &mut source)?;

    if saved.parts.is_empty() {
        return Err("Recording is empty".into());
    }

    Ok(saved)
}

fn suffix(name: &str) -> &str {
    let found = Path::new(name)
        .extension()
        .and_then(|suffix| suffix.to_str());
    found
        .filter(|suffix| {
            suffix.len() <= MAX_SUFFIX && suffix.chars().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or(DEFAULT_SUFFIX)
}

#[tauri::command]
pub async fn audio_transcribe(
    app: AppHandle,
    vault: State<'_, Vault>,
    recorder: State<'_, Recorder>,
    file: StoredAudio,
) -> Result<Outcome, String> {
    let language = language_tag(&file.language)?;
    let source = (file.space, file.doc, file.id);
    let file = private_folder(&app)?.join(format!("{}.{}", Uuid::new_v4(), suffix(&file.name)));
    let path = c_path(&file)?;
    let (sender, finished) = oneshot::channel();

    {
        let mut desk = recorder.desk()?;

        if desk.transcribing.is_some() {
            return Err(BUSY.into());
        }

        desk.transcribing = Some(sender);
    }

    let result = heard(&app, &vault, source, &file, &path, &language, finished).await;
    let _ = std::fs::remove_file(&file);

    if let Ok(mut desk) = recorder.desk() {
        desk.transcribing = None;
    }

    result
}

async fn heard(
    app: &AppHandle,
    vault: &Vault,
    (space, doc, id): (Uuid, Uuid, Uuid),
    file: &Path,
    path: &CStr,
    language: &CStr,
    finished: oneshot::Receiver<Result<Outcome, String>>,
) -> Result<Outcome, String> {
    let out = std::fs::File::create(file).map_err(|_| "Audio unavailable")?;

    file_reading::write_file(app, vault, space, doc, id, out).await?;

    unsafe { kladde_audio_transcribe(path.as_ptr(), language.as_ptr(), transcript_notice) };

    match tokio::time::timeout(FINISH_LIMIT, finished).await {
        Ok(Ok(result)) => result,
        _ => Err("Transcription could not be finished".into()),
    }
}

#[tauri::command]
pub async fn audio_languages(recorder: State<'_, Recorder>) -> Result<Vec<String>, String> {
    let (sender, listed) = oneshot::channel();

    {
        let mut desk = recorder.desk()?;

        if desk.languages.is_some() {
            return Err(BUSY.into());
        }

        desk.languages = Some(sender);
    }

    unsafe { kladde_audio_languages(languages_notice) };
    let result = tokio::time::timeout(LANGUAGE_LIMIT, listed).await;

    if let Ok(mut desk) = recorder.desk() {
        desk.languages = None;
    }

    match result {
        Ok(Ok(languages)) => languages,
        _ => Err("Languages unavailable".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_tags_are_plain_subtags() {
        assert!(language_tag("de-DE").is_ok());
        assert!(language_tag("zh-Hans-CN").is_ok());
        assert!(language_tag("").is_err());
        assert!(language_tag("de_DE").is_err());
        assert!(language_tag("de-").is_err());
        assert!(language_tag("../x").is_err());
        assert!(language_tag(&"a".repeat(MAX_LANGUAGE + 1)).is_err());
    }

    #[test]
    fn temporary_names_keep_only_short_plain_suffixes() {
        assert_eq!(suffix("Aufnahme.MP3"), "MP3");
        assert_eq!(suffix("notiz.wav"), "wav");
        assert_eq!(suffix("ohne"), DEFAULT_SUFFIX);
        assert_eq!(suffix("a.b/../c"), DEFAULT_SUFFIX);
        assert_eq!(suffix("lang.abcdefg"), DEFAULT_SUFFIX);
    }

    #[test]
    fn only_final_events_settle_a_recording() {
        let done = serde_json::json!({"kind":"done","seconds":2.5,"text":"Hallo","transcribed":true,"reason":""});
        let result = outcome(&done).unwrap().unwrap();

        assert_eq!((result.seconds, result.text.as_str()), (2.5, "Hallo"));
        assert!(result.transcribed);
        let failed = serde_json::json!({"kind":"failed","reason":"microphone"});

        assert_eq!(outcome(&failed).unwrap().unwrap_err(), "microphone");
        assert!(outcome(&serde_json::json!({"kind":"level","level":0.2})).is_none());
        assert!(outcome(&serde_json::json!({"level":0.2})).is_none());
    }

    #[test]
    fn events_from_an_abandoned_recording_are_ignored() {
        let mut desk = Desk::default();
        let old = desk.next_generation();
        let current = desk.next_generation();

        desk.active = true;
        let late = serde_json::json!({"kind":"failed","reason":"input","generation":old});

        assert!(!current_event(&mut desk, &late));
        assert!(desk.active);
        let unmarked = serde_json::json!({"kind":"done"});

        assert!(!current_event(&mut desk, &unmarked));
        let done = serde_json::json!({"kind":"done","generation":current});

        assert!(current_event(&mut desk, &done));
        assert!(!desk.active);
    }

    #[test]
    fn discarding_releases_a_hanging_finish() {
        let mut desk = Desk::default();
        let (sender, mut finished) = oneshot::channel();

        desk.finishing = Some(sender);
        desk.abandon_finishing();
        assert!(desk.finishing.is_none());
        assert_eq!(finished.try_recv().unwrap().unwrap_err(), DISCARDED);
    }
}
