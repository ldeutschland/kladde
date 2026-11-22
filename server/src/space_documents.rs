use crate::{
    App, Fault, ROW_CHARGE, Result, Shared, auth::checks::request_signed, bad, compat::unproven,
    request_owner, require_member, sync_socket::change_feed::announce,
};

use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};

use kladde_protocol::{
    Server,
    account::{discard_message, purge_message},
    compat::Peer,
};

use sqlx_core::{query::query, row::Row};
use uuid::Uuid;

pub(crate) async fn next_mark(tx: &mut sqlx_postgres::PgConnection, space: Uuid) -> Result<i64> {
    Ok(
        query("UPDATE workspaces SET mark=mark+1 WHERE id=$1 RETURNING mark")
            .bind(space)
            .fetch_one(tx)
            .await?
            .get(0),
    )
}

pub async fn documents(
    State(relay): State<App>,
    headers: HeaderMap,
    Path(space): Path<Uuid>,
) -> Result<Json<Vec<Uuid>>> {
    let (account, _) = request_owner(&relay, &headers).await?;

    require_member(&relay, account, space).await?;

    Ok(Json(
        query("SELECT id FROM documents WHERE space=$1 ORDER BY id LIMIT 50001")
            .bind(space)
            .fetch_all(&relay.pool)
            .await?
            .iter()
            .map(|r| r.get(0))
            .collect(),
    ))
}

pub(crate) const MAX_LISTED: i64 = 500_001;

#[derive(serde::Deserialize)]
pub struct Since {
    after: Option<i64>,
}

pub async fn space_state(
    State(relay): State<App>,
    headers: HeaderMap,
    Path(space): Path<Uuid>,
    Query(since): Query<Since>,
) -> Result<Json<kladde_protocol::account::SpaceState>> {
    let (account, _) = request_owner(&relay, &headers).await?;

    require_member(&relay, account, space).await?;
    let after = since.after.unwrap_or(0);
    let mark: i64 = query("SELECT mark FROM workspaces WHERE id=$1")
        .bind(space)
        .fetch_one(&relay.pool)
        .await?
        .get(0);
    let docs = query(
        "SELECT id,seq FROM documents WHERE space=$1 AND (mark>$2 OR $2=0) ORDER BY id LIMIT $3",
    )
    .bind(space)
    .bind(after)
    .bind(MAX_LISTED)
    .fetch_all(&relay.pool)
    .await?
    .iter()
    .map(|r| (r.get(0), r.get(1)))
    .collect();
    let deleted =
        query("SELECT id FROM deletions WHERE space=$1 AND (mark>$2 OR $2=0) ORDER BY id LIMIT $3")
            .bind(space)
            .bind(after)
            .bind(MAX_LISTED)
            .fetch_all(&relay.pool)
            .await?
            .iter()
            .map(|r| r.get(0))
            .collect();
    Ok(Json(kladde_protocol::account::SpaceState {
        docs,
        deleted,
        checkpoints: true,
        mark: Some(mark),
    }))
}

async fn stored_bytes(
    tx: &mut sqlx_postgres::PgConnection,
    space: Uuid,
    docs: &[Uuid],
) -> Result<i64> {
    Ok(query("SELECT COALESCE(SUM(COALESCE(octet_length(wire),0)+$3),0)::bigint FROM updates WHERE space=$1 AND doc=ANY($2)")
        .bind(space)
        .bind(docs)
        .bind(ROW_CHARGE)
        .fetch_one(&mut *tx)
        .await?
        .get(0))
}

async fn adjust_usage(
    tx: &mut sqlx_postgres::PgConnection,
    relay: &Shared,
    account: Uuid,
    change: i64,
) -> Result<()> {
    let adjusted = query(
        "UPDATE accounts SET used=GREATEST(0,used+$1) WHERE id=$2 AND ($1<=0 OR used+$1<=$3)",
    )
    .bind(change)
    .bind(account)
    .bind(relay.quota)
    .execute(&mut *tx)
    .await?;

    if adjusted.rows_affected() != 1 {
        return Err(Fault(StatusCode::INSUFFICIENT_STORAGE));
    }

    Ok(())
}

pub async fn purge(
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
        &purge_message(account, space, id)?,
    )
    .await?;
    let mut tx = relay.pool.begin().await?;
    let mark = next_mark(&mut tx, space).await?;

    let marked =
        query("INSERT INTO deletions(space,id,mark) VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
            .bind(space)
            .bind(id)
            .bind(mark)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    let freed = stored_bytes(&mut tx, space, &[id]).await?;

    query("DELETE FROM documents WHERE id=$1 AND space=$2")
        .bind(id)
        .bind(space)
        .execute(&mut *tx)
        .await?;
    adjust_usage(&mut tx, &relay, account, marked as i64 * ROW_CHARGE - freed).await?;
    tx.commit().await?;
    announce(&relay, space, device, &Server::Removed { space, doc: id });

    Ok(StatusCode::NO_CONTENT.into_response())
}

const DISCARD_LIMIT: usize = 2500;

#[derive(serde::Deserialize)]
pub struct Discard {
    owner: Uuid,
    ids: Vec<Uuid>,
}

pub async fn discard(
    State(relay): State<App>,
    Extension(peer): Extension<Peer>,
    headers: HeaderMap,
    Path(space): Path<Uuid>,
    Json(Discard { owner, ids }): Json<Discard>,
) -> Result<Response> {
    if let Some(outdated) = unproven(&peer) {
        return Ok(outdated);
    }

    let (account, device) = request_owner(&relay, &headers).await?;

    require_member(&relay, account, space).await?;

    if ids.len() > DISCARD_LIMIT {
        return Err(bad());
    }

    request_signed(
        &relay,
        &headers,
        account,
        device,
        &discard_message(account, space, owner, &ids)?,
    )
    .await?;
    let mut tx = relay.pool.begin().await?;

    next_mark(&mut tx, space).await?;
    query("SELECT 1 FROM deletions WHERE space=$1 AND id=$2")
        .bind(space)
        .bind(owner)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(bad)?;
    let freed = stored_bytes(&mut tx, space, &ids).await?;

    query("DELETE FROM documents WHERE space=$1 AND id=ANY($2)")
        .bind(space)
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    adjust_usage(&mut tx, &relay, account, -freed).await?;
    tx.commit().await?;

    Ok(StatusCode::NO_CONTENT.into_response())
}
