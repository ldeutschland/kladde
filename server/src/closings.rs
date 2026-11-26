use crate::{
    App, Fault, Result, Shared,
    auth::checks::{device_signed, verify_signature},
    bad, request_owner, require_member,
};

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
};

use kladde_crypto as c;
use kladde_protocol::{
    Certificate,
    account::{
        ChainHead, Closing, ClosingProof, DeviceClosing, SpaceClosings, SpaceHeads, closing_message,
    },
    decode, decode_attachment, encode,
};

use sqlx_core::{query::query, row::Row};
use sqlx_postgres::{PgConnection, PgRow};
use uuid::Uuid;

const CHAIN_HEADS: &str = "SELECT DISTINCT ON (doc,device) doc,device,counter,digest FROM updates WHERE space=$1 ORDER BY doc,device,counter DESC";
const STORE_CLOSING: &str = "INSERT INTO closings(space,signer,heads,proof) VALUES($1,$2,$3,$4) ON CONFLICT(space,signer) DO UPDATE SET heads=excluded.heads,proof=excluded.proof";
const ROTATION_SIGNER: Uuid = Uuid::nil();

fn head_of(row: &PgRow) -> Result<ChainHead> {
    let counter = u64::try_from(row.get::<i64, _>(2)).map_err(|_| bad())?;
    let digest: [u8; 32] = row.get::<Vec<u8>, _>(3).try_into().map_err(|_| bad())?;

    Ok((row.get(0), row.get(1), counter, digest))
}

async fn chain_heads(conn: &mut PgConnection, space: Uuid) -> Result<Vec<u8>> {
    let rows = query(CHAIN_HEADS).bind(space).fetch_all(&mut *conn).await?;
    let mut heads = rows.iter().map(head_of).collect::<Result<Vec<_>>>()?;

    heads.sort_unstable();

    Ok(encode(&heads)?)
}

async fn space_heads(conn: &mut PgConnection, space: Uuid, mark: i64) -> Result<SpaceHeads> {
    Ok(SpaceHeads {
        space,
        mark,
        heads: chain_heads(conn, space).await?,
    })
}

type Snapshot = sqlx_core::transaction::Transaction<'static, sqlx_postgres::Postgres>;

async fn consistent_snapshot(relay: &Shared) -> Result<Snapshot> {
    let mut tx = relay.pool.begin().await?;

    query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;

    Ok(tx)
}

pub(crate) struct RotationState {
    pub(crate) heads: Vec<SpaceHeads>,
    pub(crate) closings: Vec<SpaceClosings>,
    pub(crate) signers: Vec<Certificate>,
}

async fn account_signers(conn: &mut PgConnection, account: Uuid) -> Result<Vec<Certificate>> {
    let rows = query("SELECT cert FROM devices WHERE account=$1 ORDER BY id")
        .bind(account)
        .fetch_all(&mut *conn)
        .await?;

    rows.iter()
        .map(|row| Ok(decode::<Certificate>(&row.get::<Vec<u8>, _>(0))?))
        .collect()
}

pub(crate) async fn rotation_state(relay: &Shared, account: Uuid) -> Result<RotationState> {
    let mut tx = consistent_snapshot(relay).await?;
    let spaces = query("SELECT id,mark FROM workspaces WHERE owner=$1 ORDER BY id")
        .bind(account)
        .fetch_all(&mut *tx)
        .await?;
    let mut state = RotationState {
        heads: Vec::with_capacity(spaces.len()),
        closings: Vec::with_capacity(spaces.len()),
        signers: account_signers(&mut tx, account).await?,
    };

    for row in &spaces {
        let space: Uuid = row.get(0);

        state
            .heads
            .push(space_heads(&mut tx, space, row.get(1)).await?);
        state.closings.push(SpaceClosings {
            space,
            lists: space_lists(&mut tx, space).await?,
        });
    }

    tx.commit().await?;

    Ok(state)
}

pub async fn heads(
    State(relay): State<App>,
    headers: HeaderMap,
    Path(space): Path<Uuid>,
) -> Result<Json<SpaceHeads>> {
    let (account, _) = request_owner(&relay, &headers).await?;

    require_member(&relay, account, space).await?;
    let mut tx = consistent_snapshot(&relay).await?;
    let mark: i64 = query("SELECT mark FROM workspaces WHERE id=$1")
        .bind(space)
        .fetch_one(&mut *tx)
        .await?
        .get(0);
    let heads = space_heads(&mut tx, space, mark).await?;

    tx.commit().await?;

    Ok(Json(heads))
}

const SPACE_LISTS: &str = "SELECT c.heads,c.proof,d.cert FROM closings c LEFT JOIN devices d ON d.id=c.signer WHERE c.space=$1 ORDER BY c.signer";

async fn space_lists(conn: &mut PgConnection, space: Uuid) -> Result<Vec<Closing>> {
    let rows = query(SPACE_LISTS).bind(space).fetch_all(&mut *conn).await?;

    rows.iter().map(closing_of).collect()
}

fn closing_of(row: &PgRow) -> Result<Closing> {
    let signer = row
        .get::<Option<Vec<u8>>, _>(2)
        .map(|cert| decode::<Certificate>(&cert))
        .transpose()?;

    Ok(Closing {
        signer,
        heads: row.get(0),
        proof: row.get(1),
    })
}

pub async fn closings(
    State(relay): State<App>,
    headers: HeaderMap,
    Path(space): Path<Uuid>,
) -> Result<Json<Vec<Closing>>> {
    let (account, _) = request_owner(&relay, &headers).await?;

    require_member(&relay, account, space).await?;
    let mut conn = relay.pool.acquire().await?;

    Ok(Json(space_lists(&mut conn, space).await?))
}

pub async fn share_closing(
    State(relay): State<App>,
    headers: HeaderMap,
    Path(space): Path<Uuid>,
    Json(input): Json<DeviceClosing>,
) -> Result<StatusCode> {
    let (account, device) = request_owner(&relay, &headers).await?;

    require_member(&relay, account, space).await?;
    let message = closing_message(account, space, &c::digest(&input.heads))?;

    device_signed(&relay, account, device, &message, &input.proof).await?;
    query(STORE_CLOSING)
        .bind(space)
        .bind(device)
        .bind(&input.heads)
        .bind(&input.proof)
        .execute(&relay.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn close_space(
    tx: &mut PgConnection,
    account: Uuid,
    identity: &[u8; 32],
    closing: &ClosingProof,
) -> Result<()> {
    let mark: i64 = query("SELECT mark FROM workspaces WHERE id=$1 AND owner=$2 FOR UPDATE")
        .bind(closing.space)
        .bind(account)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(bad)?
        .get(0);

    if mark != closing.mark {
        return Err(Fault(StatusCode::PRECONDITION_FAILED));
    }

    decode_attachment::<Vec<ChainHead>>(&closing.heads)?;
    let message = closing_message(account, closing.space, &c::digest(&closing.heads))?;

    verify_signature(identity, &message, &closing.proof)?;
    query("DELETE FROM closings WHERE space=$1")
        .bind(closing.space)
        .execute(&mut *tx)
        .await?;
    query(STORE_CLOSING)
        .bind(closing.space)
        .bind(ROTATION_SIGNER)
        .bind(&closing.heads)
        .bind(&closing.proof)
        .execute(&mut *tx)
        .await?;

    Ok(())
}

pub(crate) async fn close_spaces(
    tx: &mut PgConnection,
    account: Uuid,
    identity: &[u8; 32],
    closings: &[ClosingProof],
) -> Result<()> {
    if !closings
        .windows(2)
        .all(|pair| pair[0].space < pair[1].space)
    {
        return Err(bad());
    }

    for closing in closings {
        close_space(tx, account, identity, closing).await?;
    }

    Ok(())
}
