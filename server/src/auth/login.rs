use super::{
    challenges::{Challenge, open_challenge, take_challenge, take_ticket},
    checks::{admit_client, charge_password_attempt, check_username},
    sessions::issue_session,
};

use crate::{App, Result, bad, denied};
use axum::{Json, extract::State, http::HeaderMap};
use ed25519_dalek::{Signature, VerifyingKey};
use kladde_crypto::{device_key, opaque::*};

use kladde_protocol::{account::*, decode, encode};
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};
use sqlx_core::{query::query, row::Row};

fn login_parameters() -> ServerLoginParameters<'static, 'static> {
    ServerLoginParameters {
        context: Some(CONTEXT),
        ..Default::default()
    }
}

pub async fn login_start(
    State(relay): State<App>,
    headers: HeaderMap,
    Json(input): Json<Start>,
) -> Result<Json<Reply>> {
    admit_client(&relay, &headers)?;
    check_username(&input.user)?;
    let row = query("SELECT record FROM accounts WHERE username=$1")
        .bind(&input.user)
        .fetch_optional(&relay.pool)
        .await?;
    charge_password_attempt(&relay, &input.user, row.is_some())?;

    let record = row
        .map(|login| {
            ServerRegistration::<Suite>::deserialize(login.get::<Vec<u8>, _>(0).as_slice())
        })
        .transpose()
        .map_err(|_| denied())?;
    let login = ServerLogin::start(
        &mut OsRng,
        &relay.setup,
        record,
        CredentialRequest::deserialize(&input.message).map_err(|_| bad())?,
        input.user.as_bytes(),
        login_parameters(),
    )
    .map_err(|_| denied())?;

    Ok(Json(Reply {
        challenge: open_challenge(&relay, Challenge::Login(input.user, Box::new(login.state)))?,
        message: login.message.serialize().to_vec(),
    }))
}

pub async fn login_finish(
    State(relay): State<App>,
    Json(input): Json<Login>,
) -> Result<Json<GetKeys>> {
    let Challenge::Login(name, state) = take_challenge(&relay, input.challenge)? else {
        return Err(denied());
    };

    state
        .finish(
            CredentialFinalization::deserialize(&input.message).map_err(|_| denied())?,
            login_parameters(),
        )
        .map_err(|_| denied())?;
    relay.logins.forget(&name);
    let row=query("SELECT a.id,b.bundle FROM accounts a JOIN key_blobs b ON a.id=b.account WHERE a.username=$1").bind(name).fetch_one(&relay.pool).await?;
    let secret = hex::encode(kladde_crypto::random::<32>());
    let ticket = open_challenge(
        &relay,
        Challenge::Ticket(row.get(0), Sha256::digest(secret.as_bytes()).into()),
    )?;

    Ok(Json(GetKeys {
        ticket: format!("{ticket}:{secret}"),
        bundle: decode(row.get::<Vec<u8>, _>(1).as_slice())?,
    }))
}

pub async fn enroll(State(relay): State<App>, Json(input): Json<Enroll>) -> Result<Json<Session>> {
    let account = take_ticket(&relay, &input.ticket)?;
    let row = query("SELECT identity FROM accounts WHERE id=$1")
        .bind(account)
        .fetch_one(&relay.pool)
        .await?;
    let public = VerifyingKey::from_bytes(
        row.get::<Vec<u8>, _>(0)
            .as_slice()
            .try_into()
            .map_err(|_| bad())?,
    )
    .map_err(|_| bad())?;
    let device = device_key(&public, account, &input.cert).map_err(|_| denied())?;

    device
        .verify_strict(
            &encode(&(b"kladde/v1/enroll", &input.ticket, &input.cert))?,
            &Signature::from_slice(&input.proof).map_err(|_| denied())?,
        )
        .map_err(|_| denied())?;
    let cert = encode(&input.cert)?;
    let mut tx = relay.pool.begin().await?;

    query("INSERT INTO devices VALUES($1,$2,$3,false) ON CONFLICT DO NOTHING")
        .bind(input.cert.device)
        .bind(account)
        .bind(&cert)
        .execute(&mut *tx)
        .await?;
    if query(
        "SELECT 1 FROM devices WHERE id=$1 AND account=$2 AND cert=$3 AND NOT revoked FOR UPDATE",
    )
    .bind(input.cert.device)
    .bind(account)
    .bind(cert)
    .fetch_optional(&mut *tx)
    .await?
    .is_none()
    {
        return Err(denied());
    }

    let token = issue_session(&mut tx, account, input.cert.device).await?;

    tx.commit().await?;

    Ok(Json(Session { token }))
}
