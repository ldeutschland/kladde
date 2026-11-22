use super::{
    access::extend_keyset,
    credentials::{check_user, opaque_error},
    fresh_keys::Fresh,
};

use crate::{Error, Origin, post};
use kladde_crypto::{Key, opaque::*};
use kladde_protocol::account::*;
use rand::rngs::OsRng;
use reqwest::Client;
use uuid::Uuid;
use zeroize::Zeroizing;

pub(super) async fn new_record(
    client: &Client,
    url: &Origin,
    user: &str,
    password: &str,
) -> Result<(Vec<u8>, Zeroizing<Vec<u8>>), Error> {
    check_user(user, password)?;
    let start = ClientRegistration::<Suite>::start(&mut OsRng, password.as_bytes())
        .map_err(opaque_error)?;
    let reply: Reply = post(
        client,
        url,
        "v1/register/start",
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
            RegistrationResponse::deserialize(&reply.message).map_err(opaque_error)?,
            ClientRegistrationFinishParameters {
                ksf: Some(&ksf),
                ..Default::default()
            },
        )
        .map_err(opaque_error)?;
    Ok((
        result.message.serialize().to_vec(),
        Zeroizing::new(result.export_key.to_vec()),
    ))
}

pub async fn register(
    client: &Client,
    origin: &Origin,
    user: &str,
    password: &str,
    space: Uuid,
    recovery: &Key,
) -> Result<(), Error> {
    let (record, export) = new_record(client, origin, user, password).await?;
    let account = Uuid::new_v4();
    let fresh = Fresh::new();
    let workspace = extend_keyset(&[], &fresh.public())?;
    let ring = fresh.ring(&export, recovery, account, space, &workspace)?;
    let _: bool = post(
        client,
        origin,
        "v1/register/finish",
        &Register {
            user: user.into(),
            record,
            bundle: fresh.bundle(account, space, recovery, &ring)?,
        },
    )
    .await?;

    Ok(())
}
