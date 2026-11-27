use super::{
    access::{Access, Ring},
    credentials::{check_bundle, check_user, opaque_error, open_ring},
};

use crate::{Error, Origin, post, post_limited};
use ed25519_dalek::{Signer, SigningKey};
use kladde_crypto::{self as c, Purpose, opaque::*};
use kladde_protocol::{account::*, decode, encode};
use rand::rngs::OsRng;
use reqwest::Client;
use uuid::Uuid;
use zeroize::Zeroizing;

const KEYS_REPLY_LIMIT: usize = MAX_JSON_KEYS + 64 * 1024;

pub(super) async fn unlock(
    client: &Client,
    origin: &Origin,
    user: &str,
    password: &str,
) -> Result<(GetKeys, Zeroizing<Vec<u8>>), Error> {
    check_user(user, password)?;
    let start =
        ClientLogin::<Suite>::start(&mut OsRng, password.as_bytes()).map_err(opaque_error)?;
    let reply: Reply = post(
        client,
        origin,
        "v1/login/start",
        &Start {
            user: user.into(),
            message: start.message.serialize().to_vec(),
        },
    )
    .await?;
    let ksf = ksf()?;
    let result = start
        .state
        .finish(
            &mut OsRng,
            password.as_bytes(),
            CredentialResponse::deserialize(&reply.message).map_err(opaque_error)?,
            ClientLoginFinishParameters {
                context: Some(CONTEXT),
                ksf: Some(&ksf),
                ..Default::default()
            },
        )
        .map_err(opaque_error)?;
    let keys: GetKeys = post_limited(
        client,
        origin,
        "v1/login/finish",
        &Login {
            challenge: reply.challenge,
            message: result.message.serialize().to_vec(),
        },
        KEYS_REPLY_LIMIT,
    )
    .await?;

    check_bundle(&keys.bundle)?;
    let ring: Ring = decode(&keys.bundle.keys)?;
    let master = c::unwrap(
        &result.export_key,
        keys.bundle.account,
        Purpose::Password,
        &ring.password,
    )?;

    Ok((keys, master))
}

pub async fn login(
    client: &Client,
    origin: &Origin,
    user: &str,
    password: &str,
    previous: Option<&Access>,
) -> Result<Access, Error> {
    let (keys, master) = unlock(client, origin, user, password).await?;
    let bundle = &keys.bundle;
    let (identity, workspace) = open_ring(bundle, &master)?;
    let previous = previous.filter(|p| p.account == bundle.account);

    if previous.is_some_and(|p| !workspace.starts_with(&p.workspace)) {
        return Err(Error::Conflict);
    }

    let (device, seed) = previous
        .filter(|p| p.identity == bundle.identity)
        .map(|p| (p.cert.device, Zeroizing::new(p.device_key)))
        .unwrap_or_else(|| (Uuid::new_v4(), c::key()));
    let signer = SigningKey::from_bytes(&seed);
    let cert = c::certify(
        &identity,
        bundle.account,
        device,
        signer.verifying_key().to_bytes(),
    )?;
    let proof = signer
        .sign(&encode(&(b"kladde/v1/enroll", &keys.ticket, &cert))?)
        .to_bytes()
        .to_vec();
    let session: Session = post(
        client,
        origin,
        "v1/enroll",
        &Enroll {
            ticket: keys.ticket.clone(),
            cert: cert.clone(),
            proof,
        },
    )
    .await?;

    Ok(Access {
        origin: origin.0.to_string(),
        username: user.into(),
        token: session.token,
        account: bundle.account,
        space: bundle.space,
        master: master.as_slice().try_into().map_err(opaque_error)?,
        workspace: workspace.to_vec(),
        identity: bundle.identity,
        device_key: *seed,
        cert,
    })
}

pub async fn renew(client: &Client, origin: &Origin, access: &Access) -> Result<String, Error> {
    let device = access.cert.device;
    let start: RenewChallenge =
        post(client, origin, "v1/session/start", &RenewStart { device }).await?;
    let signer = SigningKey::from_bytes(&access.device_key);
    let proof = signer
        .sign(&renew_message(start.challenge, device)?)
        .to_bytes()
        .to_vec();
    let session: Session = post(
        client,
        origin,
        "v1/session/renew",
        &Renew {
            challenge: start.challenge,
            proof,
        },
    )
    .await?;

    Ok(session.token)
}
