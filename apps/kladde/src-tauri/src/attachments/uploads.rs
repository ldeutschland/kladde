use super::{
    encrypted_files::{Local, seal_for_upload, store_locally},
    relay_blobs::{endpoint, fetch_blob, transfer_time},
    shared_texts,
};

use crate::{notebook::vault::Vault, sync::stored_account::for_space};
use kladde_protocol::decode_attachment;
use kladde_sync::account::Access;
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap},
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

const STORAGE_FULL: &str = "Sync server storage full";
const UPLOAD_DENIED: &str = "Upload denied";
const UPLOAD_CHECK_FAILED: &str = "Upload check failed";
pub const ACCESS_CHANGED: &str = "Sync access changed";
const UPLOADS_UNAVAILABLE: &str = "Uploads unavailable";
const RETRY_SECONDS: [u64; 6] = [15, 30, 60, 120, 240, 300];
const VERIFY_EVERY: Duration = Duration::from_secs(60 * 60);
const TEXTS_PER_ROUND: usize = 64;

#[derive(Default)]
struct Pause {
    failures: usize,
    until: Option<Instant>,
}

#[derive(Default)]
pub struct Uploads {
    busy: tokio::sync::Mutex<()>,
    lease: Mutex<CancellationToken>,
    again: Mutex<BTreeSet<Uuid>>,
    pause: Mutex<Pause>,
    shown: Mutex<Option<&'static str>>,
    verified: Mutex<HashMap<Uuid, Instant>>,
}

struct Job<'a> {
    app: &'a AppHandle,
    uploads: &'a Uploads,
    lease: CancellationToken,
}

#[derive(Clone, Serialize)]
struct FileStatus {
    space: Uuid,
    problem: Option<&'static str>,
}

pub fn resume(app: &AppHandle) {
    if let Some(uploads) = app.try_state::<Uploads>()
        && let Ok(mut pause) = uploads.pause.lock()
    {
        *pause = Pause::default();
    }
}

pub fn start_upload(app: &AppHandle, space: Uuid) {
    let app = app.clone();

    tauri::async_runtime::spawn(async move { upload_pending(&app, space).await });
}

pub fn change_access<T>(
    app: &AppHandle,
    change: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    app.state::<Uploads>().change_access(change)
}

async fn upload_pending(app: &AppHandle, space: Uuid) {
    let uploads = app.state::<Uploads>();

    if uploads.paused() {
        return;
    }

    let Ok(_busy) = uploads.busy.try_lock() else {
        uploads.ask_again(space);

        return;
    };

    let Some(lease) = uploads.current_lease() else {
        return;
    };

    let _hold = crate::platform::app_lifecycle::Hold::new();
    let job = Job {
        app,
        uploads: &uploads,
        lease: lease.clone(),
    };

    tokio::select! {
        () = lease.cancelled() => {}
        () = upload_spaces(&job, space) => {}
    }
}

async fn upload_spaces(job: &Job<'_>, mut space: Uuid) {
    loop {
        let outcome = upload_all(job, space).await;

        if job.lease.is_cancelled() {
            return;
        }

        job.uploads.settle(outcome.is_ok());
        job.uploads.announce(job.app, space, problem_of(&outcome));

        if outcome.is_err() {
            return;
        }

        let Some(next) = job.uploads.asked_again() else {
            return;
        };

        space = next;
    }
}

impl Uploads {
    pub(super) fn current_lease(&self) -> Option<CancellationToken> {
        self.lease.lock().ok().map(|lease| lease.clone())
    }

    pub(super) fn change_access<T>(
        &self,
        change: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut lease = self.lease.lock().map_err(|_| UPLOADS_UNAVAILABLE)?;
        let outcome = change();

        lease.cancel();
        *lease = CancellationToken::new();

        outcome
    }

    pub(super) fn while_leased<T>(
        &self,
        lease: &CancellationToken,
        work: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _unchanged = self.lease.lock().map_err(|_| ACCESS_CHANGED)?;

        if lease.is_cancelled() {
            return Err(ACCESS_CHANGED.into());
        }

        work()
    }

    fn ask_again(&self, space: Uuid) {
        if let Ok(mut again) = self.again.lock() {
            again.insert(space);
        }
    }

    fn asked_again(&self) -> Option<Uuid> {
        self.again.lock().ok()?.pop_first()
    }

    fn verification_due(&self, space: Uuid) -> bool {
        let Ok(verified) = self.verified.lock() else {
            return true;
        };

        verified
            .get(&space)
            .is_none_or(|at| at.elapsed() >= VERIFY_EVERY)
    }

    fn note_verified(&self, space: Uuid) {
        if let Ok(mut verified) = self.verified.lock() {
            verified.insert(space, Instant::now());
        }
    }

    fn paused(&self) -> bool {
        let pause = self.pause.lock().ok();

        pause
            .and_then(|pause| pause.until)
            .is_some_and(|until| until > Instant::now())
    }

    fn settle(&self, done: bool) {
        let Ok(mut pause) = self.pause.lock() else {
            return;
        };

        if done {
            *pause = Pause::default();

            return;
        }

        let step = pause.failures.min(RETRY_SECONDS.len() - 1);

        pause.failures += 1;
        pause.until = Some(Instant::now() + Duration::from_secs(RETRY_SECONDS[step]));
    }

    fn announce(&self, app: &AppHandle, space: Uuid, problem: Option<&'static str>) {
        let Ok(mut shown) = self.shown.lock() else {
            return;
        };

        if problem.is_none() && shown.is_none() {
            return;
        }
        *shown = problem;
        let _ = app.emit("sync-files", FileStatus { space, problem });
    }
}

fn problem_of(outcome: &Result<(), String>) -> Option<&'static str> {
    match outcome {
        Ok(()) => None,
        Err(problem) if problem == STORAGE_FULL => Some("full"),
        Err(_) => Some("files"),
    }
}

fn ends_job(problem: &str) -> bool {
    [STORAGE_FULL, UPLOAD_DENIED, ACCESS_CHANGED].contains(&problem)
}

async fn upload_all(job: &Job<'_>, space: Uuid) -> Result<(), String> {
    let app = job.app;
    let vault = app.state::<Vault>();
    let access = for_space(&vault, app, space)?;
    let client = kladde_sync::http().map_err(|e| e.to_string())?;
    let due = job.uploads.verification_due(space);
    let remote = if due {
        stored_on_server(&client, &access).await?
    } else {
        None
    };

    let waiting = waiting_uploads(app, &vault, &access, remote.as_ref())?;

    if due {
        job.uploads.note_verified(space);
    }

    let mut outcome = Ok(());

    for id in waiting {
        match upload_one(job, &vault, &access, &client, &id).await {
            Ok(()) => {}
            Err(problem) if ends_job(&problem) => return Err(problem),
            Err(problem) => outcome = Err(problem),
        }
    }

    if let Err(problem) = share_texts(job, &vault, &access, &client).await
        && ends_job(&problem)
    {
        return Err(problem);
    }

    outcome
}

async fn share_texts(
    job: &Job<'_>,
    vault: &Vault,
    access: &Access,
    client: &reqwest::Client,
) -> Result<(), String> {
    for _ in 0..TEXTS_PER_ROUND {
        let Some(item) = shared_texts::next_unshared(job.app, vault, access)? else {
            return Ok(());
        };

        let (doc, file) = (item.doc, item.file);
        let (id, body) = job
            .uploads
            .while_leased(&job.lease, || shared_texts::sealed_text(access, item))?;

        shared_outcome(send_text(client, access, doc, file, id, body).await?)?;
        shared_texts::mark_uploaded(job.app, vault, access, doc, file, id)?;
    }

    Ok(())
}

async fn send_text(
    client: &reqwest::Client,
    access: &Access,
    doc: Uuid,
    file: Uuid,
    id: Uuid,
    body: Vec<u8>,
) -> Result<reqwest::StatusCode, String> {
    let status = send_blob(client, access, id, body.clone()).await?;

    if status != reqwest::StatusCode::CONFLICT
        || shared_texts::relay_holds_valid(client, access, doc, file).await
    {
        return Ok(status);
    }

    kladde_sync::engine::erase_blob(client, access, id)
        .await
        .map_err(|e| match e {
            kladde_sync::Error::Auth => UPLOAD_DENIED.to_string(),
            _ => "Upload failed".to_string(),
        })?;

    send_blob(client, access, id, body).await
}

fn shared_outcome(status: reqwest::StatusCode) -> Result<(), String> {
    use reqwest::StatusCode;

    match status {
        StatusCode::CONFLICT => Ok(()),
        StatusCode::INSUFFICIENT_STORAGE => Err(STORAGE_FULL.into()),
        StatusCode::UNAUTHORIZED => Err(UPLOAD_DENIED.into()),
        status if status.is_success() => Ok(()),
        _ => Err("Upload refused".into()),
    }
}

async fn send_blob(
    client: &reqwest::Client,
    access: &Access,
    id: Uuid,
    body: Vec<u8>,
) -> Result<reqwest::StatusCode, String> {
    let response = client
        .put(endpoint(access, id)?)
        .bearer_auth(&access.token)
        .timeout(transfer_time(body.len()))
        .body(body)
        .send()
        .await
        .map_err(|_| "Upload failed")?;

    Ok(response.status())
}

pub fn upload_marker(access: &Access, id: &str) -> String {
    format!("uploaded:{}:{}:{id}", access.account, access.space)
}

async fn stored_on_server(
    client: &reqwest::Client,
    access: &Access,
) -> Result<Option<BTreeSet<Uuid>>, String> {
    kladde_sync::engine::remote_blobs(client, access)
        .await
        .map_err(|e| match e {
            kladde_sync::Error::Auth => UPLOAD_DENIED.into(),
            _ => UPLOAD_CHECK_FAILED.into(),
        })
}

fn waiting_uploads(
    app: &AppHandle,
    vault: &Vault,
    access: &Access,
    remote: Option<&BTreeSet<Uuid>>,
) -> Result<Vec<String>, String> {
    let prefix = format!("asset:{}:", access.space);
    let mut waiting = Vec::new();

    for key in vault.access(app, |store| store.state_keys(&prefix))? {
        let id = key.strip_prefix(&prefix).ok_or("Invalid local file")?;

        if !is_uploaded(app, vault, access, id, remote)? {
            waiting.push(id.to_string());
        }
    }

    Ok(waiting)
}

fn is_uploaded(
    app: &AppHandle,
    vault: &Vault,
    access: &Access,
    id: &str,
    remote: Option<&BTreeSet<Uuid>>,
) -> Result<bool, String> {
    let marker = upload_marker(access, id);
    let noted = vault.access(app, |store| store.state(&marker))?.is_some();
    let Some(remote) = remote else {
        return Ok(noted);
    };

    let stored = Uuid::parse_str(id).is_ok_and(|id| remote.contains(&id));

    if stored != noted {
        vault.access(app, |store| {
            if stored {
                store.set_state(&marker, &[1])
            } else {
                store.clear_state(&marker)
            }
        })?;
    }

    Ok(stored)
}

async fn upload_one(
    job: &Job<'_>,
    vault: &Vault,
    access: &Access,
    client: &reqwest::Client,
    id: &str,
) -> Result<(), String> {
    let app = job.app;
    let Some(bytes) = vault.access(app, |store| {
        store.state(&format!("asset:{}:{id}", access.space))
    })?
    else {
        return Ok(());
    };

    let mut local: Local =
        decode_attachment(&Zeroizing::new(bytes)).map_err(|_| "Invalid local file")?;
    if local.id.to_string() != id {
        return Err("Invalid local file".into());
    }

    let body = job
        .uploads
        .while_leased(&job.lease, || seal_for_upload(access, &local))?;
    let status = send_blob(client, access, local.id, body).await?;

    check_upload_status(client, access, &local, status).await?;
    let kept = vault.access(app, |store| {
        store.keep_sent(access.space, local.doc, local.id)
    })?;

    if !kept {
        return Ok(());
    }

    local.uploaded = true;
    store_locally(app, vault, access.space, &local)?;

    vault.access(app, |store| {
        store.set_state(&upload_marker(access, id), &[1])
    })
}

async fn check_upload_status(
    client: &reqwest::Client,
    access: &Access,
    local: &Local,
    status: reqwest::StatusCode,
) -> Result<(), String> {
    use reqwest::StatusCode;

    if status.is_success() {
        return Ok(());
    }

    match status {
        StatusCode::CONFLICT => {
            let existing = fetch_blob(client, access, local.id, local.doc).await?;

            if existing.key != local.key || existing.file != local.file {
                return Err("Blob conflict".into());
            }

            Ok(())
        }
        StatusCode::INSUFFICIENT_STORAGE => Err(STORAGE_FULL.into()),
        StatusCode::UNAUTHORIZED => Err(UPLOAD_DENIED.into()),
        _ => Err("Upload refused".into()),
    }
}
