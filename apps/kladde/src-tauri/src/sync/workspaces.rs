use super::{
    SyncState,
    error_messages::{success_or_message, to_message},
    session::fresh_access,
    stored_account::{space_keyset, space_state},
};

use crate::notebook::vault::Vault;
use kladde_sync::{
    Origin,
    account::{self, Access},
};

use tauri::{AppHandle, State};
use uuid::Uuid;

pub type SpaceList = Vec<(Uuid, Option<Vec<u8>>)>;
const MAX_SPACES: usize = 128;

fn workspaces_url(access: &Access) -> Result<url::Url, String> {
    Origin::parse(&access.origin)
        .map_err(to_message)?
        .0
        .join("v1/workspaces")
        .map_err(to_message)
}

pub async fn fetch_spaces(client: &reqwest::Client, access: &Access) -> Result<SpaceList, String> {
    let response = client
        .get(workspaces_url(access)?)
        .bearer_auth(&access.token)
        .send()
        .await
        .map_err(|_| "Sync offline")?;
    let response = success_or_message(response, "Authentication required")?;
    let spaces: SpaceList = kladde_sync::json_limited(response, 100000)
        .await
        .map_err(to_message)?;

    if spaces.len() > MAX_SPACES {
        return Err("Invalid workspace list".into());
    }

    Ok(spaces)
}

pub fn space_entries<'a>(
    access: &Access,
    spaces: &'a SpaceList,
) -> Result<Vec<(String, &'a [u8])>, String> {
    let mut entries = Vec::with_capacity(spaces.len());

    for (space, blob) in spaces.iter().filter(|(space, _)| *space != access.space) {
        let raw = blob.as_deref().ok_or("Missing workspace key")?;

        space_keyset(access, *space, raw)?;
        entries.push((space_state(access.account, *space), raw));
    }

    Ok(entries)
}

fn store_space_keys(
    vault: &Vault,
    app: &AppHandle,
    access: &Access,
    spaces: &SpaceList,
) -> Result<Vec<Uuid>, String> {
    let entries = space_entries(access, spaces)?;

    vault.access(app, |store| store.replace_states(&entries, &[]))?;

    Ok(spaces.iter().map(|(space, _)| *space).collect())
}

async fn link_space(
    vault: &Vault,
    app: &AppHandle,
    client: &reqwest::Client,
    access: &Access,
    space: Uuid,
) -> Result<(), String> {
    if vault
        .access(app, |store| store.get(space))?
        .is_none_or(|n| n.kind != "workspace")
    {
        return Err("Unknown workspace".into());
    }

    let response = client
        .post(workspaces_url(access)?)
        .bearer_auth(&access.token)
        .json(&account::new_space(access, space).map_err(to_message)?)
        .send()
        .await
        .map_err(|_| "Sync offline")?;
    success_or_message(response, "Workspace already exists or quota exceeded")?;

    Ok(())
}

pub async fn refreshed_spaces(
    vault: &Vault,
    app: &AppHandle,
    sync: &SyncState,
    client: &reqwest::Client,
) -> Result<(Access, SpaceList), String> {
    let _guard = sync.lock.lock().await;
    let access = fresh_access(vault, app, client).await?;
    let spaces = fetch_spaces(client, &access).await?;

    store_space_keys(vault, app, &access, &spaces)?;

    Ok((access, spaces))
}

#[tauri::command]
pub async fn remote_spaces(
    app: AppHandle,
    vault: State<'_, Vault>,
    sync: State<'_, SyncState>,
    link: Option<Uuid>,
) -> Result<Vec<Uuid>, String> {
    let _guard = sync.lock.lock().await;
    let client = kladde_sync::http().map_err(to_message)?;
    let access = fresh_access(&vault, &app, &client).await?;

    if let Some(space) = link {
        link_space(&vault, &app, &client, &access, space).await?;
    }

    let spaces = fetch_spaces(&client, &access).await?;

    store_space_keys(&vault, &app, &access, &spaces)
}
