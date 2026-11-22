use super::{
    SyncState,
    error_messages::{sync_error, to_message},
    session::{end_session, fresh_access},
    stored_account::{confirmed_access, for_space, forget_account, stored_access},
};

use crate::notebook::vault::Vault;
use kladde_sync::{
    Origin,
    account::{self, Access},
    engine,
};

use tauri::{AppHandle, State};
use uuid::Uuid;
use zeroize::Zeroizing;

#[tauri::command]
pub fn account_info(
    app: AppHandle,
    vault: State<Vault>,
    space: Option<Uuid>,
) -> Result<Option<(String, String, Uuid, Uuid)>, String> {
    if let Some(space) = space {
        if confirmed_access(&vault, &app)?.is_none() {
            return Ok(None);
        }

        let Ok(access) = for_space(&vault, &app, space) else {
            return Ok(None);
        };

        return Ok(Some((
            access.origin.clone(),
            access.username.clone(),
            access.space,
            access.cert.device,
        )));
    }

    Ok(confirmed_access(&vault, &app)?.map(|access| {
        (
            access.origin.clone(),
            access.username.clone(),
            access.space,
            access.cert.device,
        )
    }))
}

#[tauri::command]
pub async fn device_action(
    app: AppHandle,
    vault: State<'_, Vault>,
    sync: State<'_, SyncState>,
    action: String,
    password: Option<String>,
) -> Result<Vec<Uuid>, String> {
    let password = password.map(Zeroizing::new);
    let _guard = sync.lock.lock().await;

    if action == "disconnect" {
        return disconnect(&app, &vault, &sync);
    }

    if !matches!(action.as_str(), "list" | "erase") {
        return Err("Invalid action".into());
    }

    let http = kladde_sync::http().map_err(to_message)?;
    let auth = fresh_access(&vault, &app, &http).await?;

    if action == "list" {
        return list_devices(&http, &auth).await;
    }

    let password = password.ok_or("Current password required")?;

    erase_account(&http, &auth, &password).await?;
    forget_account(&vault, &app)?;

    Ok(vec![])
}

fn disconnect(app: &AppHandle, vault: &Vault, sync: &SyncState) -> Result<Vec<Uuid>, String> {
    let session = stored_access(vault, app).ok().flatten();

    forget_account(vault, app)?;
    sync.phrase.lock().map_err(|_| "Recovery")?.take();

    if let Some(session) = session {
        end_session(session);
    }

    Ok(vec![])
}

async fn list_devices(http: &reqwest::Client, auth: &Access) -> Result<Vec<Uuid>, String> {
    let r = engine::call(http, auth, reqwest::Method::GET, "v1/devices")
        .await
        .map_err(|e| sync_error(&e))?;
    kladde_sync::json_limited(r, 2_000_000)
        .await
        .map_err(to_message)
}

async fn erase_account(
    http: &reqwest::Client,
    auth: &Access,
    password: &str,
) -> Result<(), String> {
    let origin = Origin::parse(&auth.origin).map_err(to_message)?;

    account::erase(http, &origin, auth, password)
        .await
        .map_err(|e| match e {
            kladde_sync::Error::Auth => "Password incorrect".into(),
            other => sync_error(&other),
        })
}
