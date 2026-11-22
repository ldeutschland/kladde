pub mod change_feed;
mod history;
mod pushes;

use crate::{
    App, Result, Shared, bad, compat, request_owner, require_member, session_owner, throttled,
    token_hash,
};

use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::Response,
};

use change_feed::{Watched, next_change, notify, watch};
use history::send_history;
use kladde_protocol::{self as p, Client, Kind, Server, compat::Peer};
use pushes::push;
use std::time::Duration;
use tokio::sync::broadcast;
use uuid::Uuid;

pub const HISTORY_BUDGET_KIB: usize = 64 * 1024;
const SOCKETS_PER_ACCOUNT: u8 = 16;
const MAX_SOCKETS: usize = 256;
const SEND_TIMEOUT: Duration = Duration::from_secs(120);
const CLOSE_GRACE: Duration = Duration::from_secs(5);
const CLOSE_DRAIN: usize = 32;

pub async fn socket(
    State(relay): State<App>,
    axum::Extension(peer): axum::Extension<Peer>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    let hash = token_hash(&headers)?;
    let (account, device) = request_owner(&relay, &headers).await?;

    compat::record_format(&relay, device, peer.format).await?;
    reserve_socket(&relay, account)?;
    let failed = relay.clone();

    Ok(ws
        .max_message_size(p::MAX_WIRE)
        .max_frame_size(p::MAX_WIRE)
        .on_failed_upgrade(move |_| release_socket(&failed, account))
        .on_upgrade(move |mut ws| async move {
            let _ = serve(&relay, &mut ws, account, hash, &peer).await;

            close_gracefully(ws).await;
            release_socket(&relay, account);
        }))
}

fn reserve_socket(relay: &Shared, account: Uuid) -> Result<()> {
    let mut counts = relay.sockets.lock().map_err(|_| bad())?;
    let open_total: usize = counts.values().map(|n| usize::from(*n)).sum();
    let open_sockets = counts.entry(account).or_default();

    if *open_sockets >= SOCKETS_PER_ACCOUNT || open_total >= MAX_SOCKETS {
        return Err(throttled());
    }

    *open_sockets += 1;

    Ok(())
}

async fn close_gracefully(mut ws: WebSocket) {
    let _ = tokio::time::timeout(CLOSE_GRACE, ws.send(Message::Close(None))).await;
    let drain = async {
        for _ in 0..CLOSE_DRAIN {
            if !matches!(ws.recv().await, Some(Ok(_))) {
                break;
            }
        }
    };

    let _ = tokio::time::timeout(CLOSE_GRACE, drain).await;
}

fn release_socket(relay: &App, account: Uuid) {
    if let Ok(mut counts) = relay.sockets.lock()
        && let Some(n) = counts.get_mut(&account)
    {
        *n -= 1;

        if *n == 0 {
            counts.remove(&account);
        }
    }

    if let Ok(mut watchers) = relay.watchers.lock() {
        watchers.retain(|_, changes| changes.receiver_count() > 0);
    }
}

pub(crate) async fn send_binary(ws: &mut WebSocket, bytes: Vec<u8>) -> Result<()> {
    match tokio::time::timeout(SEND_TIMEOUT, ws.send(Message::Binary(bytes.into()))).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(bad()),
    }
}

pub(crate) async fn reply(ws: &mut WebSocket, message: &Server) -> Result<()> {
    send_binary(ws, p::packet(message)?).await
}

const IDLE_TIMEOUT: Duration = Duration::from_secs(90);

async fn admit_message(
    relay: &Shared,
    account: Uuid,
    hash: &[u8],
    message: &Message,
) -> Result<()> {
    if !relay.account_messages.allow(&account.to_string()) {
        return Err(throttled());
    }

    if matches!(message, Message::Ping(_) | Message::Pong(_)) {
        session_owner(relay, hash).await?;
    }

    Ok(())
}

async fn serve(
    relay: &Shared,
    ws: &mut WebSocket,
    account: Uuid,
    hash: [u8; 32],
    peer: &Peer,
) -> Result<()> {
    let mut watched: Option<Watched> = None;

    loop {
        let incoming = tokio::select! {
            message = tokio::time::timeout(IDLE_TIMEOUT, ws.recv()) => message.map_err(|_| bad())?,
            change = next_change(&mut watched) => {
                if !forward_change(relay, ws, &hash, watched.as_ref(), change).await? {
                    return Ok(());
                }

                continue
            }
        };

        let Some(Ok(message)) = incoming else {
            return Ok(());
        };

        admit_message(relay, account, &hash, &message).await?;
        let Message::Binary(bytes) = message else {
            if matches!(message, Message::Ping(_) | Message::Pong(_)) {
                continue;
            }

            return Ok(());
        };

        if !handle_client(relay, ws, peer, &hash, &mut watched, &bytes).await? {
            return Ok(());
        }
    }
}

async fn forward_change(
    relay: &Shared,
    ws: &mut WebSocket,
    hash: &[u8],
    watched: Option<&Watched>,
    change: std::result::Result<Option<Vec<u8>>, broadcast::error::RecvError>,
) -> Result<bool> {
    let Some(space) = watched.map(|watched| watched.space) else {
        return Ok(true);
    };

    match change {
        Ok(Some(wire)) => notify(relay, ws, hash, space, wire).await?,
        Ok(None) => {}
        Err(_) => return Ok(false),
    }

    Ok(true)
}

async fn handle_client(
    relay: &Shared,
    ws: &mut WebSocket,
    peer: &Peer,
    hash: &[u8; 32],
    watched: &mut Option<Watched>,
    bytes: &[u8],
) -> Result<bool> {
    let (account, device) = session_owner(relay, hash).await?;

    match p::unpack::<Client>(bytes)? {
        Client::Subscribe {
            space,
            doc,
            last_seq,
            ..
        } => {
            require_member(relay, account, space).await?;

            if !send_history(relay, ws, peer, space, doc, last_seq).await? {
                reply(ws, &Server::Conflict).await?;

                return Ok(false);
            }
        }
        Client::Watch { space } => {
            require_member(relay, account, space).await?;
            *watched = Some(watch(relay, space, device)?);

            reply(ws, &Server::Watching { space }).await?
        }
        Client::Ephemeral(_) => return Err(bad()),
        Client::PushUpdate(envelope) => {
            if envelope.header.kind != Kind::Update {
                return Err(bad());
            }

            push(relay, ws, peer, account, device, envelope, None).await?
        }
        Client::PushSnapshot {
            envelope,
            parent,
            covers,
        } => {
            if !matches!(envelope.header.kind, Kind::Snapshot | Kind::Checkpoint) {
                return Err(bad());
            }

            let snapshot = Some((parent, covers));

            push(relay, ws, peer, account, device, envelope, snapshot).await?
        }
    }

    Ok(true)
}
