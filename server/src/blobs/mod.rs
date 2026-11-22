pub mod storage;
mod transfers;

use crate::{
    App, BLOB_CHARGE_FLOOR, Fault, Result, Shared,
    auth::checks::request_signed,
    bad,
    blobs::storage::{BlobStorage, Staged},
    compat::unproven,
    request_owner, require_member,
    space_documents::MAX_LISTED,
};

use axum::{
    Extension, Json,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

use kladde_protocol::{self as p, account::erase_blob_message, compat::Peer};
use sqlx_core::{query::query, row::Row};
use transfers::{
    DOWNLOADS, TRANSFER_IDLE, UPLOADS, file_chunks, paced, take_slot, transfer_deadline,
};

use uuid::Uuid;

const MIN_BLOB: usize = 16;
const MAX_BLOBS: i64 = 131_072;

pub async fn put_blob(
    State(relay): State<App>,
    Path((space, id)): Path<(Uuid, Uuid)>,
    request: Request,
) -> Result<StatusCode> {
    if id.get_version_num() != 4 {
        return Err(bad());
    }

    let (account, _) = request_owner(&relay, request.headers()).await?;

    require_member(&relay, account, space).await?;
    let declared = declared_size(request.headers())?;

    ensure_room(&relay, account, space, id, declared).await?;
    let _slot = take_slot(&relay, account, &UPLOADS)?;
    let staged = stage_upload(&relay, account, request, declared).await?;

    record_blob(&relay, account, space, id, &staged).await?;

    Ok(StatusCode::CREATED)
}

async fn stage_upload(
    relay: &Shared,
    account: Uuid,
    request: Request,
    declared: usize,
) -> Result<Staged> {
    let body = paced(
        request.into_body(),
        transfer_deadline(declared as u64),
        TRANSFER_IDLE,
    );
    let staged = relay
        .blobs
        .stage(account, body, declared)
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::FileTooLarge => Fault(StatusCode::PAYLOAD_TOO_LARGE),
            _ => bad(),
        })?;
    if staged.size != declared {
        return Err(bad());
    }

    Ok(staged)
}

async fn record_blob(
    relay: &Shared,
    account: Uuid,
    space: Uuid,
    id: Uuid,
    staged: &Staged,
) -> Result<()> {
    let mut tx = relay.pool.begin().await?;

    query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(account)
        .fetch_one(&mut *tx)
        .await?;
    refuse_other_space(&mut tx, account, space, id).await?;

    if !relay.blobs.exists(account, id).await.map_err(|_| bad())? {
        remove_blob_row(&mut tx, account, space, id).await?;
    }

    refuse_too_many(&mut tx, account).await?;
    charge_blob(&mut tx, relay, account, staged.size).await?;
    query("INSERT INTO blobs VALUES($1,$2,$3)")
        .bind(id)
        .bind(space)
        .bind(staged.size as i64)
        .execute(&mut *tx)
        .await?;
    relay
        .blobs
        .keep(staged, account, id)
        .await
        .map_err(|_| bad())?;
    tx.commit().await?;

    Ok(())
}

async fn refuse_other_space(
    tx: &mut sqlx_postgres::PgConnection,
    account: Uuid,
    space: Uuid,
    id: Uuid,
) -> Result<()> {
    let elsewhere = query("SELECT 1 FROM blobs b JOIN memberships m ON m.space=b.space WHERE b.id=$1 AND m.account=$2 AND b.space<>$3")
        .bind(id)
        .bind(account)
        .bind(space)
        .fetch_optional(&mut *tx)
        .await?;
    if elsewhere.is_some() {
        return Err(Fault(StatusCode::CONFLICT));
    }

    Ok(())
}

async fn refuse_too_many(tx: &mut sqlx_postgres::PgConnection, account: Uuid) -> Result<()> {
    let stored: i64 = query("SELECT COUNT(*) FROM (SELECT 1 FROM blobs b JOIN memberships m ON m.space=b.space WHERE m.account=$1 LIMIT $2) counted")
        .bind(account)
        .bind(MAX_BLOBS)
        .fetch_one(&mut *tx)
        .await?
        .get(0);

    if stored >= MAX_BLOBS {
        return Err(Fault(StatusCode::INSUFFICIENT_STORAGE));
    }

    Ok(())
}

fn charged(size: usize) -> i64 {
    (size as i64).max(BLOB_CHARGE_FLOOR)
}

async fn charge_blob(
    tx: &mut sqlx_postgres::PgConnection,
    relay: &Shared,
    account: Uuid,
    size: usize,
) -> Result<()> {
    let consumed = query("UPDATE accounts SET used=used+$1 WHERE id=$2 AND used+$1<=$3")
        .bind(charged(size))
        .bind(account)
        .bind(relay.quota)
        .execute(&mut *tx)
        .await?;
    if consumed.rows_affected() != 1 {
        return Err(Fault(StatusCode::INSUFFICIENT_STORAGE));
    }

    Ok(())
}

fn declared_size(headers: &HeaderMap) -> Result<usize> {
    let size: usize = headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or(Fault(StatusCode::LENGTH_REQUIRED))?;
    if size > p::MAX_ENCODED_ATTACHMENT {
        return Err(Fault(StatusCode::PAYLOAD_TOO_LARGE));
    }

    if size < MIN_BLOB {
        return Err(bad());
    }

    Ok(size)
}

async fn ensure_room(
    relay: &Shared,
    account: Uuid,
    space: Uuid,
    id: Uuid,
    size: usize,
) -> Result<()> {
    let fits: bool = query("SELECT a.used-COALESCE((SELECT GREATEST(b.size,$6) FROM blobs b WHERE b.id=$2 AND b.space=$3),0)+$4<=$5 FROM accounts a WHERE a.id=$1")
        .bind(account)
        .bind(id)
        .bind(space)
        .bind(charged(size))
        .bind(relay.quota)
        .bind(BLOB_CHARGE_FLOOR)
        .fetch_one(&relay.pool)
        .await?
        .get(0);
    if !fits {
        return Err(Fault(StatusCode::INSUFFICIENT_STORAGE));
    }

    Ok(())
}

pub async fn erase_blob(
    State(relay): State<App>,
    Extension(peer): Extension<Peer>,
    headers: HeaderMap,
    Path((space, id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    if let Some(outdated) = unproven(&peer) {
        return Ok(outdated);
    }

    let (account, device) = request_owner(&relay, &headers).await?;

    require_member(&relay, account, space).await?;
    request_signed(
        &relay,
        &headers,
        account,
        device,
        &erase_blob_message(account, space, id)?,
    )
    .await?;
    let mut tx = relay.pool.begin().await?;

    if remove_blob_row(&mut tx, account, space, id).await? {
        relay
            .blobs
            .erase_file(account, id)
            .await
            .map_err(|_| bad())?;
    }

    tx.commit().await?;

    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn remove_blob_row(
    tx: &mut sqlx_postgres::PgConnection,
    account: Uuid,
    space: Uuid,
    id: Uuid,
) -> Result<bool> {
    let removed = query("DELETE FROM blobs WHERE id=$1 AND space=$2 RETURNING GREATEST(size,$3)")
        .bind(id)
        .bind(space)
        .bind(BLOB_CHARGE_FLOOR)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(row) = removed else {
        return Ok(false);
    };

    query("UPDATE accounts SET used=GREATEST(0,used-$1) WHERE id=$2")
        .bind(row.get::<i64, _>(0))
        .bind(account)
        .execute(&mut *tx)
        .await?;
    Ok(true)
}

pub async fn list_blobs(
    State(relay): State<App>,
    headers: HeaderMap,
    Path(space): Path<Uuid>,
) -> Result<Json<Vec<Uuid>>> {
    let (account, _) = request_owner(&relay, &headers).await?;

    require_member(&relay, account, space).await?;
    let listed: Vec<Uuid> = query("SELECT id FROM blobs WHERE space=$1 ORDER BY id LIMIT $2")
        .bind(space)
        .bind(MAX_LISTED)
        .fetch_all(&relay.pool)
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    let present = relay.blobs.stored(account).await.map_err(|_| bad())?;

    Ok(Json(
        listed
            .into_iter()
            .filter(|id| present.contains(id))
            .collect(),
    ))
}

pub async fn get_blob(
    State(relay): State<App>,
    headers: HeaderMap,
    Path((space, id)): Path<(Uuid, Uuid)>,
) -> Result<Response> {
    let (account, _) = request_owner(&relay, &headers).await?;

    require_member(&relay, account, space).await?;
    query("SELECT 1 FROM blobs WHERE id=$1 AND space=$2")
        .bind(id)
        .bind(space)
        .fetch_one(&relay.pool)
        .await?;
    let slot = take_slot(&relay, account, &DOWNLOADS)?;
    let (file, size) = relay.blobs.open(account, id).await.map_err(|_| bad())?;
    let chunks = file_chunks(file, slot, transfer_deadline(size), TRANSFER_IDLE);
    let body = axum::body::Body::from_stream(chunks);

    Ok((
        [(axum::http::header::CONTENT_LENGTH, size.to_string())],
        body,
    )
        .into_response())
}
