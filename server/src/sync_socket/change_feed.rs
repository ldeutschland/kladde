use super::send_binary;
use crate::{Result, Shared, bad, require_member, session_owner};
use axum::extract::ws::WebSocket;
use kladde_protocol::{self as p, Server};
use tokio::sync::broadcast;
use uuid::Uuid;

const CHANGE_BACKLOG: usize = 1024;

#[derive(Clone)]
pub struct Change {
    device: Uuid,
    wire: Vec<u8>,
}

pub(crate) struct Watched {
    pub(crate) space: Uuid,
    device: Uuid,
    changes: broadcast::Receiver<Change>,
}

pub(crate) fn watch(relay: &Shared, space: Uuid, device: Uuid) -> Result<Watched> {
    let mut watchers = relay.watchers.lock().map_err(|_| bad())?;
    let changes = watchers
        .entry(space)
        .or_insert_with(|| broadcast::channel(CHANGE_BACKLOG).0)
        .subscribe();
    Ok(Watched {
        space,
        device,
        changes,
    })
}

pub(crate) fn announce(relay: &Shared, space: Uuid, device: Uuid, message: &Server) {
    let Ok(wire) = p::packet(message) else {
        return;
    };

    let Ok(mut watchers) = relay.watchers.lock() else {
        return;
    };

    if let Some(changes) = watchers.get(&space)
        && changes.send(Change { device, wire }).is_err()
    {
        watchers.remove(&space);
    }
}

pub(crate) fn close_watchers(relay: &Shared, space: Uuid) {
    if let Ok(mut watchers) = relay.watchers.lock() {
        watchers.remove(&space);
    }
}

pub(crate) async fn next_change(
    watched: &mut Option<Watched>,
) -> std::result::Result<Option<Vec<u8>>, broadcast::error::RecvError> {
    let Some(w) = watched else {
        return std::future::pending().await;
    };

    let change = w.changes.recv().await?;

    Ok((change.device != w.device).then_some(change.wire))
}

pub(crate) async fn notify(
    relay: &Shared,
    ws: &mut WebSocket,
    hash: &[u8],
    space: Uuid,
    wire: Vec<u8>,
) -> Result<()> {
    let (account, _) = session_owner(relay, hash).await?;

    require_member(relay, account, space).await?;

    send_binary(ws, wire).await
}
