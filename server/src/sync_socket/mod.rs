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
use std::{sync::Arc, time::Duration};
use tokio::sync::{Semaphore, broadcast};
use uuid::Uuid;

pub const HISTORY_BUDGET_KIB: usize = 256 * 1024;
const ACCOUNT_HISTORY_KIB: usize = 16 * 1024;
const SOCKETS_PER_ACCOUNT: u8 = 16;
const MAX_SOCKETS: usize = 1024;
const SOCKET_READ_BUFFER: usize = 16 * 1024;
const SEND_GRACE: Duration = Duration::from_secs(10);
const SLOWEST_SEND: u64 = 64 * 1024;
const CLOSE_GRACE: Duration = Duration::from_secs(5);
const CLOSE_DRAIN: usize = 32;

pub struct AccountSockets {
    open: u8,
    history: Arc<Semaphore>,
}

pub async fn socket(
    State(relay): State<App>,
    axum::Extension(peer): axum::Extension<Peer>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response> {
    let hash = token_hash(&headers)?;
    let (account, device) = request_owner(&relay, &headers).await?;

    compat::record_format(&relay, device, peer.format).await?;
    let history = reserve_socket(&relay, account)?;
    let failed = relay.clone();

    Ok(ws
        .max_message_size(p::MAX_WIRE)
        .max_frame_size(p::MAX_WIRE)
        .read_buffer_size(SOCKET_READ_BUFFER)
        .on_failed_upgrade(move |_| release_socket(&failed, account))
        .on_upgrade(move |mut ws| async move {
            let _ = serve(&relay, &mut ws, account, hash, &peer, &history).await;

            close_gracefully(ws).await;
            release_socket(&relay, account);
        }))
}

fn reserve_socket(relay: &Shared, account: Uuid) -> Result<Arc<Semaphore>> {
    let mut accounts = relay.sockets.lock().map_err(|_| bad())?;
    let open_total: usize = accounts.values().map(|known| usize::from(known.open)).sum();
    let open_here = accounts.get(&account).map_or(0, |known| known.open);

    if open_here >= SOCKETS_PER_ACCOUNT || open_total >= MAX_SOCKETS {
        return Err(throttled());
    }

    let sockets = accounts.entry(account).or_insert_with(|| AccountSockets {
        open: 0,
        history: Arc::new(Semaphore::new(ACCOUNT_HISTORY_KIB)),
    });

    sockets.open += 1;

    Ok(sockets.history.clone())
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
    if let Ok(mut accounts) = relay.sockets.lock()
        && let Some(sockets) = accounts.get_mut(&account)
    {
        sockets.open -= 1;

        if sockets.open == 0 {
            accounts.remove(&account);
        }
    }

    if let Ok(mut watchers) = relay.watchers.lock() {
        watchers.retain(|_, changes| changes.receiver_count() > 0);
    }
}

fn send_deadline(bytes: usize) -> Duration {
    SEND_GRACE + Duration::from_secs(bytes as u64 / SLOWEST_SEND)
}

pub(crate) async fn send_binary(ws: &mut WebSocket, bytes: Vec<u8>) -> Result<()> {
    let deadline = send_deadline(bytes.len());

    match tokio::time::timeout(deadline, ws.send(Message::Binary(bytes.into()))).await {
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
    history: &Semaphore,
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

        if !handle_client(relay, ws, peer, &hash, history, &mut watched, &bytes).await? {
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
    history: &Semaphore,
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

            if !send_history(relay, ws, peer, history, space, doc, last_seq).await? {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_send_may_only_take_as_long_as_the_slowest_rate_allows() {
        assert_eq!(send_deadline(1), SEND_GRACE);
        assert_eq!(
            send_deadline(p::MAX_WIRE),
            SEND_GRACE + Duration::from_secs(128)
        );
    }
}
