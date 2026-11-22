use super::{
    challenges::{Challenge, open_challenge, take_challenge},
    checks::admit_client,
};

use crate::{App, Result, bad, denied, token_hash};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
};

use ed25519_dalek::{Signature, VerifyingKey};
use kladde_crypto::device_key;
use kladde_protocol::{account::*, decode};
use sha2::{Digest, Sha256};
use sqlx_core::{query::query, row::Row};
use uuid::Uuid;

pub(super) async fn issue_session(
    tx: &mut sqlx_postgres::PgConnection,
    account: Uuid,
    device: Uuid,
) -> Result<String> {
    let token = hex::encode(kladde_crypto::random::<32>());

    query("DELETE FROM sessions WHERE expires<=now() OR device=$1")
        .bind(device)
        .execute(&mut *tx)
        .await?;
    query("INSERT INTO sessions VALUES($1,$2,$3,now()+interval '24 hours')")
        .bind(Sha256::digest(token.as_bytes()).as_slice())
        .bind(account)
        .bind(device)
        .execute(&mut *tx)
        .await?;
    Ok(token)
}

pub async fn renew_start(
    State(relay): State<App>,
    headers: HeaderMap,
    Json(input): Json<RenewStart>,
) -> Result<Json<RenewChallenge>> {
    admit_client(&relay, &headers)?;

    if input.device.get_version_num() != 4 {
        return Err(bad());
    }

    query("SELECT 1 FROM devices WHERE id=$1 AND NOT revoked")
        .bind(input.device)
        .fetch_optional(&relay.pool)
        .await?
        .ok_or_else(denied)?;
    Ok(Json(RenewChallenge {
        challenge: open_challenge(&relay, Challenge::Renew(input.device))?,
    }))
}

fn verify_renewal(
    identity: &[u8],
    account: Uuid,
    cert: &[u8],
    renewal: &Renew,
    device: Uuid,
) -> Result<()> {
    let public = VerifyingKey::from_bytes(identity.try_into().map_err(|_| denied())?)
        .map_err(|_| denied())?;
    let cert: kladde_protocol::Certificate = decode(cert)?;

    if cert.device != device {
        return Err(denied());
    }

    device_key(&public, account, &cert)
        .map_err(|_| denied())?
        .verify_strict(
            &renew_message(renewal.challenge, device)?,
            &Signature::from_slice(&renewal.proof).map_err(|_| denied())?,
        )
        .map_err(|_| denied())
}

pub async fn renew_finish(
    State(relay): State<App>,
    Json(input): Json<Renew>,
) -> Result<Json<Session>> {
    let Challenge::Renew(device) = take_challenge(&relay, input.challenge)? else {
        return Err(denied());
    };

    let mut tx = relay.pool.begin().await?;
    let row = query("SELECT d.account,d.cert,a.identity FROM devices d JOIN accounts a ON a.id=d.account WHERE d.id=$1 AND NOT d.revoked FOR UPDATE OF d")
        .bind(device)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(denied)?;
    let account: Uuid = row.get(0);

    verify_renewal(
        &row.get::<Vec<u8>, _>(2),
        account,
        &row.get::<Vec<u8>, _>(1),
        &input,
        device,
    )?;
    let token = issue_session(&mut tx, account, device).await?;

    tx.commit().await?;

    Ok(Json(Session { token }))
}

pub async fn logout(State(relay): State<App>, headers: HeaderMap) -> Result<StatusCode> {
    query("DELETE FROM sessions WHERE token=$1")
        .bind(token_hash(&headers)?.as_slice())
        .execute(&relay.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
