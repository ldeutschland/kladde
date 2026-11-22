use super::checks::{admit_client, charge_password_attempt, check_bundle, check_username};
use crate::{App, Result, bad};
use axum::{Json, extract::State, http::HeaderMap};
use kladde_crypto::opaque::*;
use kladde_protocol::{account::*, encode};
use sqlx_core::query::query;
use uuid::Uuid;

pub async fn register_start(
    State(relay): State<App>,
    headers: HeaderMap,
    Json(input): Json<Start>,
) -> Result<Json<Reply>> {
    admit_client(&relay, &headers)?;
    check_username(&input.user)?;
    let known = query("SELECT 1 FROM accounts WHERE username=$1")
        .bind(&input.user)
        .fetch_optional(&relay.pool)
        .await?
        .is_some();

    charge_password_attempt(&relay, &input.user, known)?;
    let msg = RegistrationRequest::deserialize(&input.message).map_err(|_| bad())?;
    let registration = ServerRegistration::<Suite>::start(&relay.setup, msg, input.user.as_bytes())
        .map_err(|_| bad())?;
    Ok(Json(Reply {
        challenge: Uuid::new_v4(),
        message: registration.message.serialize().to_vec(),
    }))
}

pub async fn register_finish(
    State(relay): State<App>,
    headers: HeaderMap,
    Json(input): Json<Register>,
) -> Result<Json<bool>> {
    admit_client(&relay, &headers)?;
    check_username(&input.user)?;
    check_bundle(&input.bundle)?;
    let record = ServerRegistration::<Suite>::finish(
        RegistrationUpload::deserialize(&input.record).map_err(|_| bad())?,
    );
    let bundle = input.bundle;
    let mut tx = relay.pool.begin().await?;

    query("INSERT INTO accounts(id,username,record,identity,recovery) VALUES($1,$2,$3,$4,$5)")
        .bind(bundle.account)
        .bind(input.user)
        .bind(record.serialize().as_slice())
        .bind(bundle.identity.as_slice())
        .bind(bundle.recovery_public.as_slice())
        .execute(&mut *tx)
        .await?;
    query("INSERT INTO key_blobs VALUES($1,$2)")
        .bind(bundle.account)
        .bind(encode(&bundle)?)
        .execute(&mut *tx)
        .await?;
    query("INSERT INTO workspaces VALUES($1,$2)")
        .bind(bundle.space)
        .bind(bundle.account)
        .execute(&mut *tx)
        .await?;
    query("INSERT INTO memberships VALUES($1,$2)")
        .bind(bundle.space)
        .bind(bundle.account)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(true))
}
