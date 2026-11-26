use super::{
    challenges::{Challenge, open_challenge, take_challenge, take_ticket},
    checks::{admit_client, check_bundle, check_username, verify_signature},
};

use crate::{
    App, BLOB_CHARGE_FLOOR, Fault, ROW_CHARGE, Result, Shared, bad,
    blobs::storage::BlobStorage,
    closings::{account_heads, close_spaces},
    denied,
};

use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};

use kladde_crypto::opaque::*;
use kladde_protocol::{account::*, decode, encode};
use sqlx_core::{query::query, row::Row};
use uuid::Uuid;

pub const DECOY_SEED: &[u8] = b"kladde/v1/decoy-seed";
const DECOY_ACCOUNT: &[u8] = b"kladde/v1/decoy-account";

fn decoy_account(relay: &Shared, name: &str) -> Result<Uuid> {
    let bytes = kladde_crypto::derive(relay.decoys.as_ref(), name.as_bytes(), DECOY_ACCOUNT)
        .map_err(|_| bad())?;
    let mut id = [0u8; 16];

    id.copy_from_slice(&bytes[..16]);

    Ok(uuid::Builder::from_random_bytes(id).into_uuid())
}

pub async fn recovery_start(
    State(relay): State<App>,
    headers: HeaderMap,
    Json(input): Json<RecoveryStart>,
) -> Result<Json<RecoveryChallenge>> {
    admit_client(&relay, &headers)?;
    check_username(&input.user)?;
    let known = query("SELECT id FROM accounts WHERE username=$1")
        .bind(&input.user)
        .fetch_optional(&relay.pool)
        .await?;
    let account = match known {
        Some(row) => row.get(0),
        None => decoy_account(&relay, &input.user)?,
    };

    Ok(Json(RecoveryChallenge {
        nonce: open_challenge(&relay, Challenge::Recovery(account))?,
        account,
    }))
}

pub async fn recovery_keys(
    State(relay): State<App>,
    Json(input): Json<RecoveryKeys>,
) -> Result<Json<RecoveryInfo>> {
    let Challenge::Recovery(account) = take_challenge(&relay, input.nonce)? else {
        return Err(denied());
    };

    let row = query("SELECT a.recovery,a.identity,b.bundle FROM accounts a JOIN key_blobs b ON b.account=a.id WHERE a.id=$1")
        .bind(account)
        .fetch_optional(&relay.pool)
        .await?
        .ok_or_else(denied)?;
    let message = recovery_keys_message(input.nonce, account)?;
    let holds = |column: usize| {
        verify_signature(&row.get::<Vec<u8>, _>(column), &message, &input.proof).is_ok()
    };

    if !holds(0) && !holds(1) {
        return Err(denied());
    }

    let spaces = query("SELECT k.space,k.key_blob FROM workspace_keys k JOIN workspaces w ON w.id=k.space WHERE w.owner=$1 ORDER BY k.space")
        .bind(account)
        .fetch_all(&relay.pool)
        .await?
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    Ok(Json(RecoveryInfo {
        nonce: open_challenge(&relay, Challenge::Rekey(account))?,
        bundle: decode(&row.get::<Vec<u8>, _>(2))?,
        spaces,
        heads: account_heads(&relay, account).await?,
    }))
}

fn rekey_signer(
    relay: &App,
    account: Uuid,
    stored: &AccountBundle,
    reset: &Reset,
) -> Result<[u8; 32]> {
    let Some(ticket) = &reset.login_ticket else {
        return Ok(stored.recovery_public);
    };

    if take_ticket(relay, ticket)? != account {
        return Err(denied());
    }

    Ok(stored.identity)
}

fn verify_rekey(public: &[u8; 32], reset: &Reset) -> Result<()> {
    let message = encode(&(
        b"kladde/v1/rekey",
        reset.nonce,
        &reset.login_ticket,
        &reset.record,
        &reset.bundle,
        &reset.spaces,
    ))?;

    verify_signature(public, &message, &reset.proof)
}

async fn replace_space_keys(
    tx: &mut sqlx_postgres::PgConnection,
    account: Uuid,
    spaces: &[(Uuid, Vec<u8>)],
    repairs: bool,
) -> Result<Vec<Uuid>> {
    let owned: Vec<Uuid> = query("SELECT k.space FROM workspace_keys k JOIN workspaces w ON w.id=k.space WHERE w.owner=$1 ORDER BY k.space FOR UPDATE")
        .bind(account)
        .fetch_all(&mut *tx)
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    let provided: Vec<Uuid> = spaces.iter().map(|(id, _)| *id).collect();
    let dropped: Vec<Uuid> = owned
        .iter()
        .filter(|id| !provided.contains(id))
        .copied()
        .collect();
    if !provided.windows(2).all(|w| w[0] < w[1])
        || provided.iter().any(|id| !owned.contains(id))
        || (!repairs && !dropped.is_empty())
        || spaces.iter().any(|(_, k)| !(48..=8192).contains(&k.len()))
    {
        return Err(Fault(StatusCode::CONFLICT));
    }

    for (space, key) in spaces {
        query("UPDATE workspace_keys SET key_blob=$1 WHERE space=$2")
            .bind(key)
            .bind(space)
            .execute(&mut *tx)
            .await?;
    }

    Ok(dropped)
}

pub(super) async fn drop_spaces(
    tx: &mut sqlx_postgres::PgConnection,
    account: Uuid,
    spaces: &[Uuid],
) -> Result<Vec<Uuid>> {
    let mut files = Vec::new();

    for space in spaces {
        let freed: i64 = query("SELECT (COALESCE((SELECT SUM(COALESCE(octet_length(wire),0)+$2) FROM updates WHERE space=$1),0)+COALESCE((SELECT SUM(GREATEST(size,$3)) FROM blobs WHERE space=$1),0)+COALESCE((SELECT COUNT(*)*$2 FROM deletions WHERE space=$1),0))::bigint")
            .bind(space)
            .bind(ROW_CHARGE)
            .bind(BLOB_CHARGE_FLOOR)
            .fetch_one(&mut *tx)
            .await?
            .get(0);
        let stored = query("SELECT id FROM blobs WHERE space=$1")
            .bind(space)
            .fetch_all(&mut *tx)
            .await?;
        files.extend(stored.iter().map(|r| r.get::<Uuid, _>(0)));
        query("DELETE FROM workspaces WHERE id=$1 AND owner=$2")
            .bind(space)
            .bind(account)
            .execute(&mut *tx)
            .await?;
        query("UPDATE accounts SET used=GREATEST(0,used-$1) WHERE id=$2")
            .bind(freed)
            .bind(account)
            .execute(&mut *tx)
            .await?;
    }

    Ok(files)
}

pub async fn recovery_finish(
    State(relay): State<App>,
    Json(input): Json<Reset>,
) -> Result<Json<bool>> {
    let Challenge::Rekey(account) = take_challenge(&relay, input.nonce)? else {
        return Err(denied());
    };

    check_bundle(&input.bundle)?;
    let mut tx = relay.pool.begin().await?;

    query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(account)
        .fetch_one(&mut *tx)
        .await?;
    let row = query("SELECT bundle FROM key_blobs WHERE account=$1 FOR UPDATE")
        .bind(account)
        .fetch_one(&mut *tx)
        .await?;
    let stored: AccountBundle = decode(&row.get::<Vec<u8>, _>(0))?;

    if input.bundle.account != account || input.bundle.space != stored.space {
        return Err(denied());
    }

    verify_rekey(&rekey_signer(&relay, account, &stored, &input)?, &input)?;
    let record = ServerRegistration::<Suite>::finish(
        RegistrationUpload::deserialize(&input.record).map_err(|_| bad())?,
    );

    close_spaces(&mut tx, account, &input.bundle.identity, &input.closings).await?;
    let repairs = input.login_ticket.is_none();
    let dropped = replace_space_keys(&mut tx, account, &input.spaces, repairs).await?;
    let files = drop_spaces(&mut tx, account, &dropped).await?;

    query("UPDATE accounts SET record=$1,identity=$2,recovery=$3 WHERE id=$4")
        .bind(record.serialize().as_slice())
        .bind(input.bundle.identity.as_slice())
        .bind(input.bundle.recovery_public.as_slice())
        .bind(account)
        .execute(&mut *tx)
        .await?;
    query("UPDATE key_blobs SET bundle=$1 WHERE account=$2")
        .bind(encode(&input.bundle)?)
        .bind(account)
        .execute(&mut *tx)
        .await?;
    query("UPDATE devices SET revoked=true WHERE account=$1")
        .bind(account)
        .execute(&mut *tx)
        .await?;
    query("DELETE FROM sessions WHERE account=$1")
        .bind(account)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    erase_unreferenced(&relay, account, files).await;

    Ok(Json(true))
}

pub(super) async fn erase_unreferenced(relay: &App, account: Uuid, files: Vec<Uuid>) {
    for file in files {
        let referenced = query("SELECT 1 FROM blobs b JOIN memberships m ON m.space=b.space WHERE b.id=$1 AND m.account=$2")
            .bind(file)
            .bind(account)
            .fetch_optional(&relay.pool)
            .await;
        if matches!(referenced, Ok(None)) {
            let _ = relay.blobs.erase_file(account, file).await;
        }
    }
}
