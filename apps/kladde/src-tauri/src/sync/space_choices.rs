use super::{
    SyncState,
    error_messages::{sync_error, to_message},
    live_watch,
    session::fresh_access,
    stored_account::{
        confirmed_access, excluded_spaces, excluded_state, forget_space, known_remote_spaces,
        space_access,
    },
    workspaces::refreshed_spaces,
};

use crate::notebook::vault::Vault;
use kladde_sync::{Socket, account::Access, engine};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use tauri::{AppHandle, State};
use uuid::Uuid;

const MAX_TITLE_CHARS: usize = 200;
const EXCLUDED_MARK: &[u8] = &[1];
const UNKNOWN_SPACE: &str = "Unknown workspace";
const FIRST_SPACE_STAYS: &str = "The account's first notebook stays on the server";
const NOT_ON_DEVICE: &str = "Workspace not on this device";

#[derive(Serialize)]
pub struct Choice {
    id: Uuid,
    title: Option<String>,
    local: bool,
    remote: bool,
    excluded: bool,
    primary: bool,
}

struct Known {
    primary: Uuid,
    local: Vec<(Uuid, String)>,
    remote: BTreeSet<Uuid>,
    excluded: BTreeSet<Uuid>,
}

impl Known {
    fn read(
        vault: &Vault,
        app: &AppHandle,
        access: &Access,
        remote: BTreeSet<Uuid>,
    ) -> Result<Self, String> {
        Ok(Self {
            primary: access.space,
            local: vault.access(app, |store| store.spaces())?,
            remote,
            excluded: excluded_spaces(vault, app, access.account)?,
        })
    }

    fn remote_only(&self) -> Vec<Uuid> {
        let local: BTreeSet<Uuid> = self.local.iter().map(|(id, _)| *id).collect();

        self.remote
            .iter()
            .filter(|id| !local.contains(id))
            .copied()
            .collect()
    }

    fn choice(&self, id: Uuid, title: Option<String>, local: bool) -> Choice {
        Choice {
            id,
            title,
            local,
            remote: self.remote.contains(&id),
            excluded: self.excluded.contains(&id),
            primary: id == self.primary,
        }
    }

    fn choices(&self, titles: &BTreeMap<Uuid, String>) -> Vec<Choice> {
        let mut choices: Vec<Choice> = self
            .local
            .iter()
            .map(|(id, title)| self.choice(*id, Some(title.clone()), true))
            .collect();

        for id in self.remote_only() {
            choices.push(self.choice(id, titles.get(&id).cloned(), false));
        }

        choices
    }
}

async fn title_of(
    socket: &mut Socket,
    vault: &Vault,
    app: &AppHandle,
    space: Uuid,
) -> Result<Option<String>, kladde_sync::Error> {
    let Ok(reader) = space_access(vault, app, space) else {
        return Ok(None);
    };

    let title = engine::space_title(socket, &reader).await?;

    Ok(title.map(|title| title.chars().take(MAX_TITLE_CHARS).collect()))
}

async fn remote_titles(
    vault: &Vault,
    app: &AppHandle,
    access: &Access,
    spaces: &[Uuid],
) -> BTreeMap<Uuid, String> {
    let mut titles = BTreeMap::new();

    if spaces.is_empty() {
        return titles;
    }

    let Ok(mut socket) = Socket::connect(access).await else {
        return titles;
    };

    for space in spaces {
        match title_of(&mut socket, vault, app, *space).await {
            Ok(Some(title)) => {
                titles.insert(*space, title);
            }
            Ok(None) => {}
            Err(_) => match Socket::connect(access).await {
                Ok(fresh) => socket = fresh,
                Err(_) => break,
            },
        }
    }

    titles
}

#[tauri::command]
pub async fn sync_choices(
    app: AppHandle,
    vault: State<'_, Vault>,
    sync: State<'_, SyncState>,
    refresh: bool,
) -> Result<Vec<Choice>, String> {
    if !refresh {
        let access = confirmed_access(&vault, &app)?.ok_or("Not connected")?;
        let remote = known_remote_spaces(&vault, &app, &access)?;

        return Ok(Known::read(&vault, &app, &access, remote)?.choices(&BTreeMap::new()));
    }

    let client = kladde_sync::http().map_err(to_message)?;
    let (access, spaces) = refreshed_spaces(&vault, &app, &sync, &client).await?;
    let remote = spaces.iter().map(|(space, _)| *space).collect();
    let known = Known::read(&vault, &app, &access, remote)?;
    let titles = remote_titles(&vault, &app, &access, &known.remote_only()).await;

    Ok(known.choices(&titles))
}

#[tauri::command]
pub fn exclude_space(
    app: AppHandle,
    vault: State<Vault>,
    space: Uuid,
    excluded: bool,
) -> Result<(), String> {
    let access = confirmed_access(&vault, &app)?.ok_or("Not connected")?;
    let marker = excluded_state(access.account, space);

    if excluded && !known_remote_spaces(&vault, &app, &access)?.contains(&space) {
        return Err(UNKNOWN_SPACE.into());
    }

    vault.access(&app, |store| {
        if excluded {
            store.set_state(&marker, EXCLUDED_MARK)
        } else {
            store.clear_state(&marker)
        }
    })?;
    live_watch::wake(&app);

    Ok(())
}

fn check_removable(
    vault: &Vault,
    app: &AppHandle,
    access: &Access,
    space: Uuid,
) -> Result<(), String> {
    if space == access.space {
        return Err(FIRST_SPACE_STAYS.into());
    }

    if !known_remote_spaces(vault, app, access)?.contains(&space) {
        return Err(UNKNOWN_SPACE.into());
    }

    if vault
        .access(app, |store| store.get(space))?
        .is_none_or(|n| n.kind != "workspace")
    {
        return Err(NOT_ON_DEVICE.into());
    }

    Ok(())
}

#[tauri::command]
pub async fn remove_space(
    app: AppHandle,
    vault: State<'_, Vault>,
    sync: State<'_, SyncState>,
    space: Uuid,
) -> Result<(), String> {
    let _guard = sync.lock.lock().await;
    let client = kladde_sync::http().map_err(to_message)?;
    let access = fresh_access(&vault, &app, &client).await?;

    check_removable(&vault, &app, &access, space)?;
    engine::remove_space(&client, &access, space)
        .await
        .map_err(|e| sync_error(&e))?;
    forget_space(&vault, &app, access.account, space)?;
    live_watch::wake(&app);

    Ok(())
}
