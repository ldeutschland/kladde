use super::{
    challenges::take_ticket,
    checks::{device_signed, request_signed},
    recovery::{drop_spaces, erase_unreferenced},
};

use crate::{
    App, Fault, Result, bad, blobs::storage::BlobStorage, denied, request_owner,
    sync_socket::change_feed::close_watchers, token_hash,
};

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};

use kladde_protocol::{account::*, decode};
use sqlx_core::{query::query, row::Row};
use sqlx_postgres::PgConnection;
use uuid::Uuid;

pub async fn devices(State(relay): State<App>, headers: HeaderMap) -> Result<Json<Vec<Uuid>>> {
    let (account, _) = request_owner(&relay, &headers).await?;

    Ok(Json(
        query("SELECT id FROM devices WHERE account=$1 AND NOT revoked")
            .bind(account)
            .fetch_all(&relay.pool)
            .await?
            .iter()
            .map(|r| r.get(0))
            .collect(),
    ))
}

pub async fn erase(
    State(relay): State<App>,
    headers: HeaderMap,
    Json(confirmed): Json<Erase>,
) -> Result<StatusCode> {
    let (account, _) = request_owner(&relay, &headers).await?;

    if take_ticket(&relay, &confirmed.ticket)? != account {
        return Err(denied());
    }

    query("DELETE FROM accounts WHERE id=$1")
        .bind(account)
        .execute(&relay.pool)
        .await?;
    let _ = relay.blobs.erase_account(account).await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn add_space(
    State(relay): State<App>,
    headers: HeaderMap,
    Json(input): Json<NewSpace>,
) -> Result<Json<bool>> {
    if input.space.get_version_num() != 4 || !(48..=1024).contains(&input.wrapped.len()) {
        return Err(bad());
    }

    let hash = token_hash(&headers)?;
    let (account, device) = request_owner(&relay, &headers).await?;
    let message = space_key_message(account, input.space, &input.wrapped)?;

    device_signed(&relay, account, device, &message, &input.proof).await?;
    let mut tx = relay.pool.begin().await?;

    lock_session(&mut tx, account, &hash).await?;
    let count: i64 = query("SELECT COUNT(*) FROM workspaces WHERE owner=$1")
        .bind(account)
        .fetch_one(&mut *tx)
        .await?
        .get(0);
    if count >= 128 {
        return Err(bad());
    }

    query("INSERT INTO workspaces VALUES($1,$2)")
        .bind(input.space)
        .bind(account)
        .execute(&mut *tx)
        .await?;
    query("INSERT INTO memberships VALUES($1,$2)")
        .bind(input.space)
        .bind(account)
        .execute(&mut *tx)
        .await?;
    query("INSERT INTO workspace_keys VALUES($1,$2)")
        .bind(input.space)
        .bind(input.wrapped)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(true))
}

async fn lock_session(tx: &mut PgConnection, account: Uuid, hash: &[u8]) -> Result<()> {
    query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(account)
        .fetch_one(&mut *tx)
        .await?;
    query("SELECT 1 FROM sessions WHERE token=$1 AND account=$2 AND expires>now()")
        .bind(hash)
        .bind(account)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(denied)?;

    Ok(())
}

async fn primary_space(tx: &mut PgConnection, account: Uuid) -> Result<Uuid> {
    let row = query("SELECT bundle FROM key_blobs WHERE account=$1")
        .bind(account)
        .fetch_one(&mut *tx)
        .await?;
    let bundle: AccountBundle = decode(&row.get::<Vec<u8>, _>(0))?;

    Ok(bundle.space)
}

async fn owns_space(tx: &mut PgConnection, account: Uuid, space: Uuid) -> Result<bool> {
    let owned = query("SELECT 1 FROM workspaces WHERE id=$1 AND owner=$2 FOR UPDATE")
        .bind(space)
        .bind(account)
        .fetch_optional(&mut *tx)
        .await?;

    Ok(owned.is_some())
}

pub async fn remove_space(
    State(relay): State<App>,
    headers: HeaderMap,
    Path(space): Path<Uuid>,
) -> Result<StatusCode> {
    let hash = token_hash(&headers)?;
    let (account, device) = request_owner(&relay, &headers).await?;
    let message = remove_space_message(account, space)?;

    request_signed(&relay, &headers, account, device, &message).await?;
    let mut tx = relay.pool.begin().await?;

    lock_session(&mut tx, account, &hash).await?;

    if space == primary_space(&mut tx, account).await? {
        return Err(Fault(StatusCode::CONFLICT));
    }

    if !owns_space(&mut tx, account, space).await? {
        return Ok(StatusCode::NO_CONTENT);
    }

    let files = drop_spaces(&mut tx, account, &[space]).await?;

    tx.commit().await?;
    erase_unreferenced(&relay, account, files).await;
    close_watchers(&relay, space);

    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_spaces(
    State(relay): State<App>,
    headers: HeaderMap,
) -> Result<Json<Vec<(Uuid, Option<Vec<u8>>)>>> {
    let (account, _) = request_owner(&relay, &headers).await?;
    let rows=query("SELECT w.id,k.key_blob FROM workspaces w LEFT JOIN workspace_keys k ON k.space=w.id WHERE w.owner=$1 ORDER BY w.id").bind(account).fetch_all(&relay.pool).await?;

    Ok(Json(rows.iter().map(|r| (r.get(0), r.get(1))).collect()))
}
