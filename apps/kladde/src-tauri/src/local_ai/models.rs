use crate::platform::app_lifecycle::Hold;

use futures_util::StreamExt;
use reqwest::{Client, Response, StatusCode, header::RANGE, redirect};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::{c_char, c_int, c_void},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    ptr,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

const GIB: u64 = 1 << 30;
const FOLDER: &str = "models";
const PART_SUFFIX: &str = ".part";
const CACHE_SEPARATOR: &str = "_";
const EVENT: &str = "local-model";
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_REDIRECTS: usize = 5;
const HASH_BUFFER: usize = 1 << 20;
const TRUSTED_HOST: &str = "huggingface.co";
const TRUSTED_SUFFIX: &str = ".hf.co";
const STORAGE: &str = "storage";
const NETWORK: &str = "network";
const UNKNOWN: &str = "Unknown model";

pub struct LocalModel {
    pub id: &'static str,
    file: &'static str,
    url: &'static str,
    sha256: &'static str,
    bytes: u64,
    memory: u64,
}

pub const MODELS: [LocalModel; 2] = [
    LocalModel {
        id: "gemma-4-e2b",
        file: "gemma-4-E2B-it.litertlm",
        url: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/2e12bfd869b2962984f97a1f2a26807316d534cc/gemma-4-E2B-it.litertlm",
        sha256: "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c",
        bytes: 2_588_147_712,
        memory: 5 * GIB,
    },
    LocalModel {
        id: "gemma-4-e4b",
        file: "gemma-4-E4B-it.litertlm",
        url: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/f254b5ba6e36f7d89cc7892e268e9877bc20f0a0/gemma-4-E4B-it.litertlm",
        sha256: "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0",
        bytes: 3_659_530_240,
        memory: 7 * GIB,
    },
];

pub fn model(id: &str) -> Result<&'static LocalModel, String> {
    MODELS
        .iter()
        .find(|model| model.id == id)
        .ok_or(UNKNOWN.into())
}

unsafe extern "C" {
    fn sysctlbyname(
        name: *const c_char,
        old: *mut c_void,
        old_length: *mut usize,
        new: *const c_void,
        new_length: usize,
    ) -> c_int;
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
unsafe extern "C" {
    fn kladde_exclude_from_backup(path: *const c_char) -> bool;
}

pub fn device_memory() -> u64 {
    let mut memory: u64 = 0;
    let mut length = std::mem::size_of::<u64>();
    let status = unsafe {
        sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&mut memory as *mut u64).cast(),
            &mut length,
            ptr::null(),
            0,
        )
    };

    if status == 0 { memory } else { 0 }
}

pub fn fits_device(model: &LocalModel) -> bool {
    device_memory() >= model.memory
}

fn exclude_from_backup(path: &Path) {
    #[cfg(any(target_os = "ios", target_os = "macos"))]
    if let Some(text) = path
        .to_str()
        .and_then(|text| std::ffi::CString::new(text).ok())
    {
        unsafe { kladde_exclude_from_backup(text.as_ptr()) };
    }

    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    let _ = path;
}

fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    let folder = app.path().app_data_dir().map_err(|_| STORAGE)?.join(FOLDER);

    fs::create_dir_all(&folder).map_err(|_| STORAGE)?;
    exclude_from_backup(&folder);

    Ok(folder)
}

fn partial(folder: &Path, model: &LocalModel) -> PathBuf {
    folder.join(format!("{}{PART_SUFFIX}", model.file))
}

fn size(path: &Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

pub fn installed(app: &AppHandle, model: &LocalModel) -> Option<PathBuf> {
    let path = folder(app).ok()?.join(model.file);

    (size(&path) == model.bytes).then_some(path)
}

struct Download {
    received: u64,
    verifying: bool,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Downloads(Mutex<HashMap<&'static str, Download>>);

impl Downloads {
    fn active(&self) -> Result<MutexGuard<'_, HashMap<&'static str, Download>>, String> {
        self.0.lock().map_err(|_| "Downloads".into())
    }

    fn update(&self, id: &str, received: u64, verifying: bool) {
        if let Ok(mut active) = self.active()
            && let Some(download) = active.get_mut(id)
        {
            download.received = received;
            download.verifying = verifying;
        }
    }

    fn finish(&self, id: &str) {
        if let Ok(mut active) = self.active() {
            active.remove(id);
        }
    }

    pub fn cancel(&self, id: &str) {
        if let Ok(active) = self.active()
            && let Some(download) = active.get(id)
        {
            download.cancel.store(true, Ordering::Release);
        }
    }
}

#[derive(Serialize)]
pub struct ModelInfo {
    id: &'static str,
    bytes: u64,
    state: &'static str,
    received: u64,
    supported: bool,
}

fn info(app: &AppHandle, downloads: &Downloads, model: &'static LocalModel) -> ModelInfo {
    let running = downloads.active().ok().and_then(|active| {
        active
            .get(model.id)
            .map(|download| (download.received, download.verifying))
    });
    let part = folder(app)
        .map(|folder| size(&partial(&folder, model)))
        .unwrap_or(0);
    let (state, received) = match running {
        Some((_, true)) => ("verifying", model.bytes),
        Some((received, false)) => ("downloading", received),
        None if installed(app, model).is_some() => ("ready", model.bytes),
        None if part > 0 => ("partial", part),
        None => ("missing", 0),
    };

    ModelInfo {
        id: model.id,
        bytes: model.bytes,
        state,
        received,
        supported: fits_device(model),
    }
}

fn trusted(url: &Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host == TRUSTED_HOST || host.ends_with(TRUSTED_SUFFIX))
}

fn client() -> Result<Client, String> {
    let policy = redirect::Policy::custom(|attempt| {
        if attempt.previous().len() < MAX_REDIRECTS && trusted(attempt.url()) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });

    Client::builder()
        .https_only(true)
        .redirect(policy)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .map_err(|_| NETWORK.into())
}

async fn request(model: &LocalModel, offset: u64) -> Result<Response, String> {
    let mut request = client()?.get(model.url);

    if offset > 0 {
        request = request.header(RANGE, format!("bytes={offset}-"));
    }

    let response = request.send().await.map_err(|_| NETWORK)?;
    let resumed = offset > 0 && response.status() == StatusCode::PARTIAL_CONTENT;

    if response.status() != StatusCode::OK && !resumed {
        return Err(NETWORK.into());
    }

    Ok(response)
}

fn open_part(path: &Path, resumed: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();

    options.create(true);

    if resumed {
        options.append(true);
    } else {
        options.write(true).truncate(true);
    }

    options.open(path).map_err(|_| STORAGE.into())
}

struct Progress<'a> {
    app: &'a AppHandle,
    downloads: &'a Downloads,
    model: &'static LocalModel,
    shown: Instant,
}

impl Progress<'_> {
    fn report(&mut self, received: u64) {
        self.downloads.update(self.model.id, received, false);

        if self.shown.elapsed() >= PROGRESS_INTERVAL {
            self.shown = Instant::now();
            emit(self.app, self.model, "downloading", received, "");
        }
    }
}

fn emit(app: &AppHandle, model: &LocalModel, state: &str, received: u64, reason: &str) {
    let event = json!({"id": model.id, "state": state, "received": received, "reason": reason});

    let _ = app.emit(EVENT, event);
}

async fn receive(
    response: Response,
    file: &mut File,
    mut received: u64,
    cancel: &AtomicBool,
    progress: &mut Progress<'_>,
) -> Result<u64, String> {
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".into());
        }

        let chunk = chunk.map_err(|_| NETWORK)?;

        received += chunk.len() as u64;

        if received > progress.model.bytes {
            return Err(NETWORK.into());
        }

        file.write_all(&chunk).map_err(|_| STORAGE)?;
        progress.report(received);
    }

    file.flush().map_err(|_| STORAGE)?;

    Ok(received)
}

fn digest(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| STORAGE)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; HASH_BUFFER];

    loop {
        let read = file.read(&mut buffer).map_err(|_| STORAGE)?;

        if read == 0 {
            return Ok(hex::encode(hasher.finalize()));
        }

        hasher.update(&buffer[..read]);
    }
}

async fn verified(part: &Path, model: &'static LocalModel) -> Result<(), String> {
    let path = part.to_path_buf();
    let hash = tauri::async_runtime::spawn_blocking(move || digest(&path))
        .await
        .map_err(|_| STORAGE)??;

    if hash != model.sha256 {
        let _ = fs::remove_file(part);

        return Err("checksum".into());
    }

    Ok(())
}

async fn fetch(
    app: &AppHandle,
    model: &'static LocalModel,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let downloads = app.state::<Downloads>();
    let folder = folder(app)?;
    let part = partial(&folder, model);
    let offset = size(&part).min(model.bytes);
    let response = request(model, offset).await?;
    let resumed = response.status() == StatusCode::PARTIAL_CONTENT;
    let mut file = open_part(&part, resumed)?;
    let start = if resumed { offset } else { 0 };
    let mut progress = Progress {
        app,
        downloads: &downloads,
        model,
        shown: Instant::now(),
    };

    let received = receive(response, &mut file, start, cancel, &mut progress).await?;

    if received != model.bytes {
        return Err(NETWORK.into());
    }

    downloads.update(model.id, received, true);
    emit(app, model, "verifying", received, "");
    verified(&part, model).await?;

    fs::rename(&part, folder.join(model.file)).map_err(|_| STORAGE.into())
}

async fn download(app: AppHandle, model: &'static LocalModel, cancel: Arc<AtomicBool>) {
    let _hold = Hold::new();
    let result = fetch(&app, model, &cancel).await;

    app.state::<Downloads>().finish(model.id);

    match result {
        Ok(()) => emit(&app, model, "ready", model.bytes, ""),
        Err(reason) => emit(&app, model, "failed", 0, &reason),
    }
}

#[tauri::command]
pub fn local_models(app: AppHandle, downloads: State<Downloads>) -> Vec<ModelInfo> {
    MODELS
        .iter()
        .map(|model| info(&app, &downloads, model))
        .collect()
}

#[tauri::command]
pub fn local_model_download(
    app: AppHandle,
    downloads: State<Downloads>,
    id: String,
) -> Result<(), String> {
    let model = model(&id)?;

    if !super::SUPPORTED || !fits_device(model) {
        return Err("device".into());
    }

    if installed(&app, model).is_some() {
        return Ok(());
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let mut active = downloads.active()?;

    if active.contains_key(model.id) {
        return Ok(());
    }

    active.insert(
        model.id,
        Download {
            received: 0,
            verifying: false,
            cancel: cancel.clone(),
        },
    );
    tauri::async_runtime::spawn(download(app.clone(), model, cancel));

    Ok(())
}

#[tauri::command]
pub fn local_model_cancel(downloads: State<Downloads>, id: String) -> Result<(), String> {
    downloads.cancel(model(&id)?.id);

    Ok(())
}

#[tauri::command]
pub fn local_model_delete(
    app: AppHandle,
    downloads: State<Downloads>,
    id: String,
) -> Result<(), String> {
    let model = model(&id)?;
    let folder = folder(&app)?;

    downloads.cancel(model.id);
    super::release_model(model.id);

    for path in [folder.join(model.file), partial(&folder, model)] {
        if path.exists() {
            fs::remove_file(&path).map_err(|_| STORAGE)?;
        }
    }

    remove_caches(&super::cache_folder(&app)?, model)
}

fn remove_caches(cache: &Path, model: &LocalModel) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(cache) else {
        return Ok(());
    };

    let prefix = format!("{}{CACHE_SEPARATOR}", model.file);

    for entry in entries.flatten() {
        let named = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(&prefix));

        if named && entry.file_type().is_ok_and(|kind| kind.is_file()) {
            fs::remove_file(entry.path()).map_err(|_| STORAGE)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_models_are_well_formed() {
        for model in &MODELS {
            let url = Url::parse(model.url).unwrap();
            let revision = url.path_segments().unwrap().nth(3).unwrap();

            assert!(trusted(&url));
            assert_eq!(url.host_str(), Some(TRUSTED_HOST));
            assert_eq!(revision.len(), 40);
            assert!(revision.bytes().all(|b| b.is_ascii_hexdigit()));
            assert_eq!(model.sha256.len(), 64);
            assert!(
                model
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            );
            assert!(model.url.ends_with(model.file));
            assert!(model.bytes > GIB);
        }
    }

    #[test]
    fn downloads_only_follow_huggingface_over_https() {
        let allowed = [
            "https://huggingface.co/x",
            "https://us.aws.cdn.hf.co/x",
            "https://cas-bridge.xethub.hf.co/x",
        ];
        let refused = [
            "http://huggingface.co/x",
            "https://evil.example/x",
            "https://huggingface.co.evil.example/x",
            "https://hf.co.evil.example/x",
            "https://evilhf.co/x",
        ];

        assert!(allowed.iter().all(|url| trusted(&Url::parse(url).unwrap())));
        assert!(
            refused
                .iter()
                .all(|url| !trusted(&Url::parse(url).unwrap()))
        );
    }

    #[test]
    fn digest_matches_known_hash() {
        let path = std::env::temp_dir().join(format!("kladde-digest-{}", uuid::Uuid::new_v4()));

        fs::write(&path, b"abc").unwrap();
        let hash = digest(&path);

        fs::remove_file(&path).unwrap();
        assert_eq!(
            hash.unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn unknown_models_are_refused() {
        assert!(model("gemma-4-e2b").is_ok());
        assert!(model("../../etc/passwd").is_err());
    }

    #[test]
    fn deleting_removes_only_that_models_caches() {
        let cache = std::env::temp_dir().join(format!("kladde-cache-{}", uuid::Uuid::new_v4()));
        let own = cache.join("gemma-4-E2B-it.litertlm_1_2_weight_cache.bin");
        let other = cache.join("gemma-4-E4B-it.litertlm_1_2_weight_cache.bin");
        let unrelated = cache.join("gemma-4-E2B-it.litertlm.notes");

        fs::create_dir_all(&cache).unwrap();

        for path in [&own, &other, &unrelated] {
            fs::write(path, b"x").unwrap();
        }

        remove_caches(&cache, &MODELS[0]).unwrap();
        let left = (own.exists(), other.exists(), unrelated.exists());

        fs::remove_dir_all(&cache).unwrap();
        assert_eq!(left, (false, true, true));
        assert!(remove_caches(&cache, &MODELS[0]).is_ok());
    }
}
