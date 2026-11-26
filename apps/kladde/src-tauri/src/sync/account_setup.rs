use super::{
    SyncState,
    error_messages::{account_error, to_message},
    stored_account::{
        UNCONFIRMED, confirms_expected_keys, expect_keys, forget_expected_keys, known_keys,
        save_account, stored_access,
    },
    workspaces::fetch_spaces,
};

use crate::notebook::vault::Vault;
use kladde_crypto::{self as c, Key};
use kladde_sync::{
    Origin,
    account::{self, Proof},
    engine,
};

use tauri::{AppHandle, Manager, State};
use uuid::Uuid;
use zeroize::Zeroizing;

#[tauri::command]
pub fn phrase(sync: State<SyncState>) -> Result<(String, usize, usize), String> {
    let key = c::key();
    let words = c::recovery(&key).map_err(to_message)?;
    let index = c::random::<2>();
    let first_word = (index[0] % 12) as usize;
    let second_word = (index[1] % 12 + 12) as usize;
    *sync.phrase.lock().map_err(|_| "Recovery")? = Some((key, first_word, second_word));

    Ok((words.to_string(), first_word, second_word))
}

fn confirmed_phrase(sync: &SyncState, confirm: Option<(String, String)>) -> Result<Key, String> {
    let (key, a, b) = sync
        .phrase
        .lock()
        .map_err(|_| "Recovery")?
        .take()
        .ok_or("Recovery missing")?;
    let words = c::recovery(&key).map_err(to_message)?;
    let parts: Vec<_> = words.split_whitespace().collect();
    let confirm = confirm.ok_or("Recovery confirmation missing")?;

    if parts[a] != confirm.0.trim() || parts[b] != confirm.1.trim() {
        return Err("Recovery confirmation incorrect".into());
    }

    Ok(key)
}

#[derive(serde::Deserialize)]
pub struct Credentials {
    origin: String,
    user: String,
    password: String,
    action: String,
    confirm: Option<(String, String)>,
    recovery: Option<String>,
    previous_password: Option<String>,
}

struct Secrets {
    password: Zeroizing<String>,
    recovery: Option<Zeroizing<String>>,
    previous: Option<Zeroizing<String>>,
}

fn proof<'a>(action: &str, secrets: &'a Secrets) -> Result<Proof<'a>, String> {
    match action {
        "recover" => Ok(Proof::Recovery(
            secrets.recovery.as_ref().ok_or("Recovery missing")?,
        )),
        "change" => Ok(Proof::Password(
            secrets
                .previous
                .as_ref()
                .ok_or("Current password required")?,
        )),
        "revoke" => Ok(Proof::Password(&secrets.password)),
        _ => Err("Invalid action".into()),
    }
}

const ROTATION_ATTEMPTS: usize = 3;

async fn rotate_keys(
    vault: &Vault,
    app: &AppHandle,
    origin: &Origin,
    client: &reqwest::Client,
    input: &Credentials,
    secrets: &Secrets,
    key: &Key,
) -> Result<(), String> {
    for _ in 0..ROTATION_ATTEMPTS {
        if rotate_once(vault, app, origin, client, input, secrets, key).await? {
            return Ok(());
        }
    }

    Err(account_error(kladde_sync::Error::Stale))
}

async fn rotate_once(
    vault: &Vault,
    app: &AppHandle,
    origin: &Origin,
    client: &reqwest::Client,
    input: &Credentials,
    secrets: &Secrets,
    key: &Key,
) -> Result<bool, String> {
    let proof = proof(&input.action, secrets)?;
    let known = known_keys(vault, app, origin, &input.user)?;
    let rotation =
        account::prepare_rekey(client, origin, &input.user, proof, &secrets.password, key)
            .await
            .map_err(account_error)?;
    if let Some(known) = &known {
        rotation.continues(known).map_err(account_error)?;
    }

    crate::attachments::uploads::change_access(app, || {
        expect_keys(vault, app, &rotation.expected)
    })?;
    let Err(e) = rotation.send(client, origin).await else {
        return Ok(true);
    };

    if !refused_outright(&e) && !matches!(e, kladde_sync::Error::Stale) {
        return Err(UNCONFIRMED.into());
    }

    forget_expected_keys(vault, app)?;

    match e {
        kladde_sync::Error::Stale => Ok(false),
        other => Err(account_error(other)),
    }
}

fn refused_outright(error: &kladde_sync::Error) -> bool {
    use kladde_sync::Error;

    matches!(
        error,
        Error::Url | Error::Auth | Error::Busy | Error::Outdated(_)
    )
}

async fn prepare_account(
    vault: &Vault,
    app: &AppHandle,
    origin: &Origin,
    client: &reqwest::Client,
    space: Uuid,
    input: &mut Credentials,
    secrets: &Secrets,
) -> Result<(), String> {
    if input.action == "login" {
        return Ok(());
    }

    let key = confirmed_phrase(&app.state::<SyncState>(), input.confirm.take())?;

    if input.action == "register" {
        return account::register(client, origin, &input.user, &secrets.password, space, &key)
            .await
            .map_err(account_error);
    }

    rotate_keys(vault, app, origin, client, input, secrets, &key).await
}

#[tauri::command]
pub async fn connect_account(
    app: AppHandle,
    vault: State<'_, Vault>,
    sync: State<'_, SyncState>,
    space: Uuid,
    mut input: Credentials,
) -> Result<Uuid, String> {
    let secrets = Secrets {
        password: Zeroizing::new(std::mem::take(&mut input.password)),
        recovery: input.recovery.take().map(Zeroizing::new),
        previous: input.previous_password.take().map(Zeroizing::new),
    };

    let origin = Origin::parse(&input.origin).map_err(to_message)?;
    let client = kladde_sync::http().map_err(to_message)?;
    let _guard = sync.lock.lock().await;

    prepare_account(&vault, &app, &origin, &client, space, &mut input, &secrets).await?;
    let previous = stored_access(&vault, &app)?
        .filter(|a| a.origin == origin.0.as_str() && a.username == input.user);
    let auth = account::login(
        &client,
        &origin,
        &input.user,
        &secrets.password,
        previous.as_ref(),
    )
    .await
    .map_err(account_error)?;
    let confirms_expected = confirms_expected_keys(&vault, &app, &auth)?;
    let spaces = fetch_spaces(&client, &auth).await?;

    crate::attachments::uploads::change_access(&app, || {
        save_account(&vault, &app, &auth, &spaces, confirms_expected)
    })?;
    vault.access(&app, |store| engine::remember_fresh_sign_in(store, &auth))?;

    Ok(auth.space)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kladde_sync::Error;

    #[test]
    fn a_rotation_the_relay_refused_releases_the_lock() {
        let refused = [
            Error::Url,
            Error::Auth,
            Error::Busy,
            Error::Outdated(kladde_protocol::compat::Side::Server),
        ];

        assert!(refused.iter().all(refused_outright));
    }

    #[test]
    fn every_other_rotation_error_keeps_the_lock() {
        let kept = [
            Error::Network,
            Error::Protocol(kladde_protocol::Invalid),
            Error::Conflict,
            Error::Denied,
            Error::Storage,
        ];

        assert!(!kept.iter().any(refused_outright));
    }
}
