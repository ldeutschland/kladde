use super::{
    error_messages::to_message,
    workspaces::{SpaceList, space_entries},
};

use crate::notebook::vault::Vault;
use kladde_sync::{
    Origin,
    account::{self, Access, Expected, Known},
};

use std::collections::BTreeSet;
use tauri::AppHandle;
use uuid::Uuid;
use zeroize::Zeroizing;

pub const ACCOUNT: &str = "account";
const EXPECTED_KEYS: &str = "rekey";
pub const UNCONFIRMED: &str = "sync:unconfirmed";
const EXCLUDED: &str = "Workspace excluded";

fn space_state_prefix(account: Uuid) -> String {
    format!("workspace:{account}:")
}

fn excluded_state_prefix(account: Uuid) -> String {
    format!("excluded:{account}:")
}

pub fn space_state(account: Uuid, space: Uuid) -> String {
    format!("{}{space}", space_state_prefix(account))
}

pub fn excluded_state(account: Uuid, space: Uuid) -> String {
    format!("{}{space}", excluded_state_prefix(account))
}

fn spaces_under(vault: &Vault, app: &AppHandle, prefix: &str) -> Result<BTreeSet<Uuid>, String> {
    let keys = vault.access(app, |store| store.state_keys(prefix))?;

    Ok(keys
        .iter()
        .filter_map(|key| key.strip_prefix(prefix)?.parse().ok())
        .collect())
}

pub fn known_remote_spaces(
    vault: &Vault,
    app: &AppHandle,
    access: &Access,
) -> Result<BTreeSet<Uuid>, String> {
    let mut spaces = spaces_under(vault, app, &space_state_prefix(access.account))?;

    spaces.insert(access.space);

    Ok(spaces)
}

pub fn excluded_spaces(
    vault: &Vault,
    app: &AppHandle,
    account: Uuid,
) -> Result<BTreeSet<Uuid>, String> {
    spaces_under(vault, app, &excluded_state_prefix(account))
}

pub fn is_excluded(
    vault: &Vault,
    app: &AppHandle,
    account: Uuid,
    space: Uuid,
) -> Result<bool, String> {
    let marker = vault.access(app, |store| store.state(&excluded_state(account, space)))?;

    Ok(marker.is_some())
}

pub fn excluded_here(vault: &Vault, app: &AppHandle, space: Uuid) -> Result<bool, String> {
    let Some(access) = confirmed_access(vault, app)? else {
        return Ok(false);
    };

    is_excluded(vault, app, access.account, space)
}

pub fn stored_access(vault: &Vault, app: &AppHandle) -> Result<Option<Access>, String> {
    vault
        .access(app, |store| store.state(ACCOUNT))?
        .map(|bytes| Access::from_json(&Zeroizing::new(bytes)).map_err(to_message))
        .transpose()
}

fn expected_keys(vault: &Vault, app: &AppHandle) -> Result<Option<Expected>, String> {
    vault
        .access(app, |store| store.state(EXPECTED_KEYS))?
        .map(|bytes| Expected::from_json(&Zeroizing::new(bytes)).map_err(to_message))
        .transpose()
}

pub fn expect_keys(vault: &Vault, app: &AppHandle, expected: &Expected) -> Result<(), String> {
    let bytes = Zeroizing::new(serde_json::to_vec(expected).map_err(to_message)?);

    vault.access(app, |store| store.set_state(EXPECTED_KEYS, &bytes))
}

pub fn forget_expected_keys(vault: &Vault, app: &AppHandle) -> Result<(), String> {
    vault.access(app, |store| store.clear_state(EXPECTED_KEYS))
}

pub fn confirmed_access(vault: &Vault, app: &AppHandle) -> Result<Option<Access>, String> {
    let Some(access) = stored_access(vault, app)? else {
        return Ok(None);
    };

    if expected_keys(vault, app)?.is_some_and(|e| e.covers(&access.origin, &access.username)) {
        return Err(UNCONFIRMED.into());
    }

    Ok(Some(access))
}

pub fn space_keyset(
    access: &Access,
    space: Uuid,
    raw: &[u8],
) -> Result<Zeroizing<Vec<u8>>, String> {
    account::open_space(&access.master, &access.identity, space, raw).map_err(to_message)
}

pub fn for_space(vault: &Vault, app: &AppHandle, space: Uuid) -> Result<Access, String> {
    let access = space_access(vault, app, space)?;

    if is_excluded(vault, app, access.account, space)? {
        return Err(EXCLUDED.into());
    }

    Ok(access)
}

pub fn space_access(vault: &Vault, app: &AppHandle, space: Uuid) -> Result<Access, String> {
    let mut access = confirmed_access(vault, app)?.ok_or("Not connected")?;

    if access.space != space {
        let raw = vault
            .access(app, |store| {
                store.state(&space_state(access.account, space))
            })?
            .ok_or("Workspace not connected")?;
        let set = space_keyset(&access, space, &raw)?;

        access.use_keyset(&set).map_err(to_message)?;
        access.space = space;
    }

    Ok(access)
}

pub fn save_account(
    vault: &Vault,
    app: &AppHandle,
    auth: &Access,
    spaces: &SpaceList,
    confirms_expected: bool,
) -> Result<(), String> {
    let account = Zeroizing::new(serde_json::to_vec(auth).map_err(to_message)?);
    let mut entries = space_entries(auth, spaces)?;

    entries.push((ACCOUNT.into(), account.as_slice()));
    let cleared: &[&str] = if confirms_expected {
        &[EXPECTED_KEYS]
    } else {
        &[]
    };

    vault.access(app, |store| store.replace_states(&entries, cleared))
}

pub fn forget_account(vault: &Vault, app: &AppHandle) -> Result<(), String> {
    crate::attachments::uploads::change_access(app, || {
        vault.access(app, |store| store.clear_state(ACCOUNT))
    })
}

pub fn known_keys(
    vault: &Vault,
    app: &AppHandle,
    origin: &Origin,
    user: &str,
) -> Result<Option<Known>, String> {
    let Some(access) = stored_access(vault, app)?
        .filter(|access| access.origin == origin.0.as_str() && access.username == user)
    else {
        return Ok(None);
    };

    let mut spaces = Vec::new();

    for (space, _) in vault.access(app, |store| store.spaces())? {
        let stored = vault.access(app, |store| {
            store.state(&space_state(access.account, space))
        })?;

        if let Some(raw) = stored.filter(|_| space != access.space) {
            spaces.push((space, space_keyset(&access, space, &raw)?));
        }
    }

    Ok(Some(Known {
        account: access.account,
        workspace: Zeroizing::new(access.workspace.clone()),
        spaces,
    }))
}

pub fn confirms_expected_keys(
    vault: &Vault,
    app: &AppHandle,
    auth: &Access,
) -> Result<bool, String> {
    let Some(expected) = expected_keys(vault, app)? else {
        return Ok(false);
    };

    if !expected.covers(&auth.origin, &auth.username) {
        return Ok(false);
    }

    if !expected.confirmed_by(auth) {
        return Err(UNCONFIRMED.into());
    }

    Ok(true)
}
