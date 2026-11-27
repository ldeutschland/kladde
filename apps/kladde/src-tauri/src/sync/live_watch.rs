use crate::{
    notebook::vault::Vault,
    sync::stored_account::{excluded_here, for_space},
};

use kladde_sync::{
    Error,
    watch::{Notice, Watch},
};

use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;
use uuid::Uuid;

const RETRY_SECONDS: [u64; 6] = [1, 2, 5, 10, 30, 60];

#[derive(Default)]
pub struct Watching {
    target: Mutex<Option<Uuid>>,
    wake: Notify,
}

#[derive(Clone, Serialize)]
struct Remote {
    space: Uuid,
    docs: Vec<(Uuid, i64)>,
    full: bool,
}

#[derive(Clone, Serialize)]
struct Live {
    space: Uuid,
    live: bool,
}

#[tauri::command]
pub fn sync_watch(space: Option<Uuid>, watching: State<Watching>) -> Result<(), String> {
    let mut target = watching
        .target
        .lock()
        .map_err(|_| "Sync watch unavailable")?;

    if *target == space {
        return Ok(());
    }
    *target = space;
    drop(target);
    watching.wake.notify_one();

    Ok(())
}

pub fn wake(app: &AppHandle) {
    if let Some(watching) = app.try_state::<Watching>() {
        watching.wake.notify_one();
    }
}

pub fn target(app: &AppHandle) -> Option<Uuid> {
    let watching = app.try_state::<Watching>()?;
    *watching.target.lock().ok()?
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(watch_loop(app));
}

async fn watch_loop(app: AppHandle) {
    let mut failures = 0;

    loop {
        let watching = app.state::<Watching>();
        let Some(space) = target(&app) else {
            watching.wake.notified().await;
            continue;
        };

        if excluded_here(&app.state::<Vault>(), &app, space).unwrap_or(false) {
            let _ = app.emit("sync-live", Live { space, live: false });

            watching.wake.notified().await;
            continue;
        }

        let Err(e) = watch_space(&app, &watching, space, &mut failures).await else {
            continue;
        };

        let _ = app.emit("sync-live", Live { space, live: false });

        if matches!(e, Error::Auth) {
            announce(&app, space, Vec::new(), true);
        }

        failures += 1;

        tokio::select! {
            _ = tokio::time::sleep(retry_delay(failures)) => {}
            _ = watching.wake.notified() => {}
        }
    }
}

async fn watch_space(
    app: &AppHandle,
    watching: &Watching,
    space: Uuid,
    failures: &mut usize,
) -> Result<(), Error> {
    let access = for_space(&app.state::<Vault>(), app, space).map_err(|_| Error::Storage)?;
    let mut watch = Watch::open(&access).await?;

    drop(access);
    *failures = 0;
    let _ = app.emit("sync-live", Live { space, live: true });

    announce(app, space, Vec::new(), true);

    loop {
        let notice = tokio::select! {
            notice = watch.next() => notice?,
            _ = watching.wake.notified() => return Ok(()),
        };

        match notice {
            Notice::Changed { doc, seq } => announce(app, space, vec![(doc, seq)], false),
            Notice::Removed(_) => announce(app, space, Vec::new(), true),
        }
    }
}

fn announce(app: &AppHandle, space: Uuid, docs: Vec<(Uuid, i64)>, full: bool) {
    let _ = app.emit("sync-remote", Remote { space, docs, full });
}

fn retry_delay(failures: usize) -> Duration {
    let base = RETRY_SECONDS[failures.clamp(1, RETRY_SECONDS.len()) - 1] * 1000;
    let jitter = rand::random::<u64>() % (base / 4 + 1);

    Duration::from_millis(base + jitter)
}
