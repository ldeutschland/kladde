use crate::{
    notebook::vault::Vault,
    platform::keychain::{read_secret, write_secret},
};

use kladde_ai::{Model, Policy, Turn};
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, State, ipc::Channel};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

const RUN_TOKENS: u64 = 2_000_000;

#[derive(Default)]
pub struct Runs {
    models: Mutex<Vec<Model>>,
    active: Mutex<HashMap<Uuid, Run>>,
}

struct Run {
    space: Uuid,
    remaining: f64,
    tokens_left: u64,
    steps: u32,
    busy: bool,
    using_web: bool,
    cancel: CancellationToken,
}

pub fn policy_key(space: Uuid) -> String {
    format!("ai:{space}")
}

fn policy(app: &AppHandle, vault: &Vault, space: Uuid) -> Result<Policy, String> {
    let stored = vault.access(app, |store| store.state(&policy_key(space)))?;

    match stored {
        None => Ok(Policy::default()),
        Some(stored) => serde_json::from_slice(&stored).map_err(|_| "Invalid AI settings".into()),
    }
}

#[tauri::command]
pub fn ai_policy(app: AppHandle, vault: State<Vault>, space: Uuid) -> Result<Policy, String> {
    policy(&app, &vault, space)
}

#[tauri::command]
pub fn ai_settings(
    app: AppHandle,
    vault: State<Vault>,
    runs: State<Runs>,
    space: Uuid,
    settings: Policy,
) -> Result<(), String> {
    settings.validate().map_err(|e| e.to_string())?;
    let mut active = runs.active.lock().map_err(|_| "AI")?;
    let mut previous = policy(&app, &vault, space)?;

    previous.web_search = settings.web_search;
    let other_settings_changed = previous != settings;
    let data = serde_json::to_vec(&settings).map_err(|_| "Settings")?;

    vault.access(&app, |store| store.set_state(&policy_key(space), &data))?;
    active.retain(|_, r| {
        if r.space == space && (other_settings_changed || (r.using_web && !settings.web_search)) {
            r.cancel.cancel();

            false
        } else {
            true
        }
    });

    Ok(())
}

#[tauri::command]
pub fn ai_key(app: AppHandle, key: String) -> Result<(), String> {
    let key = Zeroizing::new(key);

    if key.len() < 12 || key.len() > 512 || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("Invalid API key".into());
    }

    write_secret(&app.config().identifier, "openrouter", key.as_bytes())
}

#[tauri::command]
pub async fn ai_models(
    app: AppHandle,
    vault: State<'_, Vault>,
    runs: State<'_, Runs>,
    space: Uuid,
) -> Result<Vec<Model>, String> {
    if !policy(&app, &vault, space)?.enabled {
        return Err("AI disabled".into());
    }

    let models = kladde_ai::models(&kladde_ai::client().map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())?;
    *runs.models.lock().map_err(|_| "AI")? = models.clone();

    Ok(models)
}

#[tauri::command]
pub fn ai_start(
    app: AppHandle,
    vault: State<Vault>,
    runs: State<Runs>,
    space: Uuid,
) -> Result<Uuid, String> {
    let settings = policy(&app, &vault, space)?;

    if !settings.enabled || settings.model.is_empty() {
        return Err("Choose a model".into());
    }

    let mut active = runs.active.lock().map_err(|_| "AI")?;

    if active.values().any(|r| r.space == space) {
        return Err("Run already active".into());
    }

    let id = Uuid::new_v4();

    active.insert(
        id,
        Run {
            space,
            remaining: settings.budget,
            tokens_left: RUN_TOKENS,
            steps: settings.steps,
            busy: false,
            using_web: false,
            cancel: CancellationToken::new(),
        },
    );

    Ok(id)
}

#[tauri::command]
pub fn ai_stop(runs: State<Runs>, run: Uuid) -> Result<(), String> {
    if let Some(r) = runs.active.lock().map_err(|_| "AI")?.remove(&run) {
        r.cancel.cancel()
    }

    Ok(())
}

struct TurnStart {
    space: Uuid,
    remaining: f64,
    tokens_left: u64,
    cancel: CancellationToken,
}

fn begin_turn(runs: &Runs, run: Uuid, web_search: bool) -> Result<TurnStart, String> {
    let mut map = runs.active.lock().map_err(|_| "AI")?;
    let active_run = map.get_mut(&run).ok_or("Unknown run")?;

    if active_run.busy || active_run.steps == 0 || active_run.remaining <= 0. {
        return Err("Run limit".into());
    }

    active_run.busy = true;
    active_run.using_web = web_search;
    active_run.steps -= 1;

    Ok(TurnStart {
        space: active_run.space,
        remaining: active_run.remaining,
        tokens_left: active_run.tokens_left,
        cancel: active_run.cancel.clone(),
    })
}

fn chosen_model(runs: &Runs, settings: &Policy) -> Result<Model, String> {
    runs.models
        .lock()
        .map_err(|_| "AI")?
        .iter()
        .find(|m| m.id == settings.model)
        .cloned()
        .ok_or_else(|| "Refresh model list".into())
}

fn api_key(app: &AppHandle) -> Result<Zeroizing<String>, String> {
    let key = read_secret(&app.config().identifier, "openrouter")?.ok_or("Enter API key")?;

    Ok(Zeroizing::new(
        std::str::from_utf8(&key)
            .map_err(|_| "Keychain")?
            .to_owned(),
    ))
}

fn finish_turn(
    runs: &Runs,
    run: Uuid,
    result: Result<(f64, u64), kladde_ai::Error>,
) -> Result<f64, String> {
    let mut map = runs.active.lock().map_err(|_| "AI")?;
    let active_run = map.get_mut(&run).ok_or("Cancelled")?;

    active_run.busy = false;
    active_run.using_web = false;

    match result {
        Ok((cost, tokens)) => {
            active_run.tokens_left = active_run.tokens_left.saturating_sub(tokens);
            active_run.remaining -= cost;

            Ok(cost)
        }
        Err(e) => {
            active_run.remaining = 0.;

            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn ai_turn(
    app: AppHandle,
    vault: State<'_, Vault>,
    runs: State<'_, Runs>,
    run: Uuid,
    turn: Turn,
    channel: Channel<serde_json::Value>,
) -> Result<f64, String> {
    let start = begin_turn(&runs, run, turn.web_search)?;
    let settings = policy(&app, &vault, start.space)?;
    let model = chosen_model(&runs, &settings)?;
    let key = api_key(&app)?;
    let result = kladde_ai::stream(
        &key,
        &settings,
        &model,
        turn,
        (start.remaining, start.tokens_left),
        start.cancel,
        |part| channel.send(part).map_err(|_| kladde_ai::Error::Cancelled),
    )
    .await;

    finish_turn(&runs, run, result)
}
