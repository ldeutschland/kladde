use super::{
    error_messages::sync_error,
    stored_account::{ACCOUNT, confirmed_access},
};

use crate::notebook::vault::Vault;
use kladde_sync::{
    Origin,
    account::{self, Access},
    engine,
};

use tauri::AppHandle;
use zeroize::Zeroizing;

pub fn end_session(session: Access) {
    tauri::async_runtime::spawn(async move {
        let Ok(http) = kladde_sync::http() else {
            return;
        };

        let _ = engine::call(&http, &session, reqwest::Method::DELETE, "v1/session").await;
    });
}

pub async fn renew_session(
    vault: &Vault,
    app: &AppHandle,
    client: &reqwest::Client,
) -> Result<(), kladde_sync::Error> {
    let mut access = confirmed_access(vault, app)
        .map_err(|_| kladde_sync::Error::Storage)?
        .ok_or(kladde_sync::Error::Auth)?;
    let origin = Origin::parse(&access.origin)?;

    access.token = account::renew(client, &origin, &access).await?;
    let bytes =
        Zeroizing::new(serde_json::to_vec(&access).map_err(|_| kladde_sync::Error::Storage)?);

    vault
        .access(app, |store| store.set_state(ACCOUNT, &bytes))
        .map_err(|_| kladde_sync::Error::Storage)
}

pub async fn fresh_access(
    vault: &Vault,
    app: &AppHandle,
    client: &reqwest::Client,
) -> Result<Access, String> {
    let access = confirmed_access(vault, app)?.ok_or("Not connected")?;

    match engine::call(client, &access, reqwest::Method::GET, "v1/workspaces").await {
        Ok(_) => return Ok(access),
        Err(kladde_sync::Error::Auth) => {}
        Err(e) => return Err(sync_error(&e)),
    }

    drop(access);
    renew_session(vault, app, client)
        .await
        .map_err(|e| sync_error(&e))?;
    confirmed_access(vault, app)?.ok_or_else(|| "Not connected".into())
}
