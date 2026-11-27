use super::{
    SyncState,
    error_messages::sync_error,
    session::renew_session,
    stored_account::{confirmed_access, excluded_spaces, for_space, syncs_here},
    workspaces::{fetch_spaces, refreshed_spaces, store_space_keys},
};

use crate::notebook::vault::Vault;
use kladde_store::Store;
use kladde_sync::engine::{self, Report};
use std::collections::BTreeSet;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

const MAX_HINTS: usize = 4096;
const SYNC_PREFIX: &str = "sync:";
const STOPS_ROUND: [&str; 3] = ["offline", "busy", "auth"];
const UNSYNCED: &str = "unsynced";

struct Device<'a> {
    vault: &'a Vault,
    app: &'a AppHandle,
    space: Uuid,
}

#[derive(Clone, serde::Serialize)]
struct SyncedDoc {
    space: Uuid,
    id: Uuid,
}

impl engine::Local for Device<'_> {
    fn with<T>(
        &self,
        work: impl FnOnce(&mut Store) -> Result<T, kladde_store::Error>,
    ) -> Result<T, kladde_sync::Error> {
        let mut guard = self
            .vault
            .lock(self.app)
            .map_err(|_| kladde_sync::Error::Storage)?;
        let store = guard.as_mut().ok_or(kladde_sync::Error::Storage)?;

        work(store).map_err(engine::local_error)
    }

    fn changed(&self, id: Uuid) {
        let synced = SyncedDoc {
            space: self.space,
            id,
        };

        let _ = self.app.emit("sync-doc", synced);
    }
}

#[tauri::command]
pub async fn sync_now(
    space: Uuid,
    full: Option<bool>,
    hints: Option<Vec<(Uuid, i64)>>,
    app: AppHandle,
) -> Result<Report, String> {
    let hints = hints.unwrap_or_default();
    let full = full.unwrap_or(true) || hints.len() > MAX_HINTS;

    run_sync(&app, space, full, &hints).await
}

#[tauri::command]
pub async fn sync_others(app: AppHandle, open: Option<Uuid>) -> Result<Vec<Uuid>, String> {
    let vault = app.state::<Vault>();
    let client = kladde_sync::http().map_err(|e| sync_error(&e))?;
    let (access, spaces) =
        refreshed_spaces(&vault, &app, &app.state::<SyncState>(), &client).await?;
    let excluded = excluded_spaces(&vault, &app, access.account)?;
    let before = local_spaces(&vault, &app)?;

    drop(access);

    for (space, _) in spaces
        .iter()
        .filter(|(space, _)| Some(*space) != open && !excluded.contains(space))
    {
        if stops_round(&run_sync(&app, *space, true, &[]).await) {
            break;
        }
    }

    let after = local_spaces(&vault, &app)?;

    Ok(after.difference(&before).copied().collect())
}

fn local_spaces(vault: &Vault, app: &AppHandle) -> Result<BTreeSet<Uuid>, String> {
    let spaces = vault.access(app, |store| store.spaces())?;

    Ok(spaces.into_iter().map(|(space, _)| space).collect())
}

fn stops_round(outcome: &Result<Report, String>) -> bool {
    let code = match outcome {
        Ok(report) => report.stopped,
        Err(problem) => problem.strip_prefix(SYNC_PREFIX),
    };

    code.is_some_and(|code| STOPS_ROUND.contains(&code))
}

#[cfg(target_os = "ios")]
pub async fn sync_on_leave(app: &AppHandle) {
    if let Some(space) = crate::sync::live_watch::target(app) {
        let _ = run_sync(app, space, false, &[]).await;
    }
}

async fn run_sync(
    app: &AppHandle,
    space: Uuid,
    full: bool,
    hints: &[(Uuid, i64)],
) -> Result<Report, String> {
    let _hold = crate::platform::app_lifecycle::Hold::new();
    let report = sync_documents(app, space, full, hints).await?;

    crate::attachments::search_index::wake();

    if report.stopped.is_none() {
        crate::attachments::uploads::start_upload(app, space);
    }

    Ok(report)
}

async fn sync_documents(
    app: &AppHandle,
    space: Uuid,
    full: bool,
    hints: &[(Uuid, i64)],
) -> Result<Report, String> {
    let sync = app.state::<SyncState>();
    let _guard = sync.lock.lock().await;
    let vault = app.state::<Vault>();

    if !syncs_here(&vault, app, space)? {
        return Ok(unsynced());
    }

    let client = kladde_sync::http().map_err(|e| sync_error(&e))?;

    if !full {
        let stuck = sync.stuck_in(space);
        let mut report = sync_hinted_docs(app, &vault, &client, space, hints, &stuck).await?;

        if !needs_complete(&report) {
            report.failed.extend(still_stuck_docs(&stuck, hints));

            return Ok(report);
        }
    }

    let report = sync_all_docs(app, &vault, &client, space).await?;

    sync.remember_stuck(space, &report.failed);

    Ok(report)
}

fn needs_complete(report: &Report) -> bool {
    report.stopped == Some("auth") || !report.failed.is_empty()
}

fn still_stuck_docs(stuck: &BTreeSet<Uuid>, hints: &[(Uuid, i64)]) -> Vec<Uuid> {
    let hinted = |id: &Uuid| hints.iter().any(|(doc, _)| doc == id);

    stuck.iter().filter(|id| !hinted(id)).copied().collect()
}

async fn sync_hinted_docs(
    app: &AppHandle,
    vault: &Vault,
    client: &reqwest::Client,
    space: Uuid,
    hints: &[(Uuid, i64)],
    stuck: &BTreeSet<Uuid>,
) -> Result<Report, String> {
    let access = for_space(vault, app, space)?;
    let local = Device { vault, app, space };

    let mut report = Report::default();

    engine::sync_changes_except(&local, client, &access, hints, stuck, &mut report).await;

    Ok(report)
}

async fn sync_latest_once(
    app: &AppHandle,
    vault: &Vault,
    client: &reqwest::Client,
    space: Uuid,
) -> Result<Report, kladde_sync::Error> {
    let access = for_space(vault, app, space).map_err(|_| kladde_sync::Error::Storage)?;
    let local = Device { vault, app, space };

    let mut report = Report::default();

    engine::sync_latest(&local, client, &access, &mut report).await?;

    Ok(report)
}

async fn sync_all_docs(
    app: &AppHandle,
    vault: &Vault,
    client: &reqwest::Client,
    space: Uuid,
) -> Result<Report, String> {
    for_space(vault, app, space)?;

    match sync_latest_once(app, vault, client, space).await {
        Err(kladde_sync::Error::Auth) => {}
        outcome => return outcome.map_err(|e| sync_error(&e)),
    }

    renew_session(vault, app, client)
        .await
        .map_err(|e| sync_error(&e))?;

    match sync_latest_once(app, vault, client, space).await {
        Err(kladde_sync::Error::Auth) => unsynced_if_removed(app, vault, client, space).await,
        renewed => renewed.map_err(|e| sync_error(&e)),
    }
}

async fn unsynced_if_removed(
    app: &AppHandle,
    vault: &Vault,
    client: &reqwest::Client,
    space: Uuid,
) -> Result<Report, String> {
    let refused = sync_error(&kladde_sync::Error::Auth);
    let access = confirmed_access(vault, app)?.ok_or("Not connected")?;
    let Ok(spaces) = fetch_spaces(client, &access).await else {
        return Err(refused);
    };

    if spaces.iter().any(|(listed, _)| *listed == space) {
        return Err(refused);
    }

    store_space_keys(vault, app, &access, &spaces)?;

    Ok(unsynced())
}

fn unsynced() -> Report {
    Report {
        stopped: Some(UNSYNCED),
        ..Report::default()
    }
}

#[tauri::command]
pub fn discard_rescued(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    id: Uuid,
) -> Result<(), String> {
    let access = for_space(&vault, &app, space)?;
    let local = Device {
        vault: &vault,
        app: &app,
        space,
    };

    engine::discard_rescued(&local, &access, id).map_err(|e| sync_error(&e))
}

#[tauri::command]
pub async fn repair_sync(space: Uuid, app: AppHandle) -> Result<(), String> {
    let sync = app.state::<SyncState>();
    let _guard = sync.lock.lock().await;
    let vault = app.state::<Vault>();
    let access = for_space(&vault, &app, space)?;
    let local = Device {
        vault: &vault,
        app: &app,
        space,
    };

    engine::resync(&local, &access).map_err(|e| sync_error(&e))
}
