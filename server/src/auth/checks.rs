use crate::{Result, Shared, admit_forwarded, bad, denied, throttled};
use axum::http::HeaderMap;
use ed25519_dalek::{Signature, VerifyingKey};
use kladde_crypto::device_key;
use kladde_protocol::{account::*, decode};
use sqlx_core::{query::query, row::Row};
use uuid::Uuid;

const PROOF_BYTES: usize = 64;

pub(super) fn admit_client(relay: &Shared, headers: &HeaderMap) -> Result<()> {
    admit_forwarded(relay.clients.as_ref(), headers)
}

pub(super) fn charge_password_attempt(relay: &Shared, user: &str, known: bool) -> Result<()> {
    if known && !relay.logins.allow(user) {
        return Err(throttled());
    }

    Ok(())
}

pub(super) fn check_username(name: &str) -> Result<()> {
    if !(3..=64).contains(&name.len())
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(bad());
    }

    Ok(())
}

pub(super) fn check_bundle(bundle: &AccountBundle) -> Result<()> {
    if bundle.version != 1
        || bundle.ksf != 1
        || bundle.keys.len() > 8192
        || bundle.keys.is_empty()
        || bundle.account.get_version_num() != 4
        || bundle.space.get_version_num() != 4
    {
        return Err(bad());
    }

    Ok(())
}

pub(crate) fn verify_signature(public: &[u8], message: &[u8], proof: &[u8]) -> Result<()> {
    VerifyingKey::from_bytes(public.try_into().map_err(|_| denied())?)
        .map_err(|_| denied())?
        .verify_strict(
            message,
            &Signature::from_slice(proof).map_err(|_| denied())?,
        )
        .map_err(|_| denied())
}

pub(crate) async fn device_public(
    relay: &Shared,
    account: Uuid,
    device: Uuid,
) -> Result<VerifyingKey> {
    let row = query("SELECT d.cert,a.identity FROM devices d JOIN accounts a ON a.id=d.account WHERE d.id=$1 AND d.account=$2 AND NOT d.revoked")
        .bind(device)
        .bind(account)
        .fetch_optional(&relay.pool)
        .await?
        .ok_or_else(denied)?;
    let identity = VerifyingKey::from_bytes(
        row.get::<Vec<u8>, _>(1)
            .as_slice()
            .try_into()
            .map_err(|_| denied())?,
    )
    .map_err(|_| denied())?;
    let cert: kladde_protocol::Certificate = decode(&row.get::<Vec<u8>, _>(0))?;

    device_key(&identity, account, &cert).map_err(|_| denied())
}

pub(crate) async fn device_signed(
    relay: &Shared,
    account: Uuid,
    device: Uuid,
    message: &[u8],
    proof: &[u8],
) -> Result<()> {
    device_public(relay, account, device)
        .await?
        .verify_strict(
            message,
            &Signature::from_slice(proof).map_err(|_| denied())?,
        )
        .map_err(|_| denied())
}

pub(crate) async fn request_signed(
    relay: &Shared,
    headers: &HeaderMap,
    account: Uuid,
    device: Uuid,
    message: &[u8],
) -> Result<Vec<u8>> {
    let proof = headers
        .get(PROOF_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| hex::decode(v).ok())
        .filter(|proof| proof.len() == PROOF_BYTES)
        .ok_or_else(denied)?;

    device_signed(relay, account, device, message, &proof).await?;

    Ok(proof)
}
