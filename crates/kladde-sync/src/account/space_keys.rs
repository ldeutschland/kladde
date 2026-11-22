use super::access::{Access, extend_keyset, keyset};
use crate::Error;
use ed25519_dalek::{Signer, SigningKey};
use kladde_crypto::{self as c, Purpose, Wrapped};
use kladde_protocol::{account::*, decode, encode};
use uuid::Uuid;
use zeroize::Zeroizing;

pub type SpaceKeys = (Uuid, Zeroizing<Vec<u8>>);

pub fn open_space(
    master: &[u8],
    identity: &[u8; 32],
    space: Uuid,
    raw: &[u8],
) -> Result<Zeroizing<Vec<u8>>, Error> {
    let wrapped: Wrapped = decode(raw)?;
    let plain = c::unwrap(master, space, Purpose::Workspace, &wrapped)?;

    keyset(&plain, identity)
}

pub fn new_space(access: &Access, space: Uuid) -> Result<NewSpace, Error> {
    let set = extend_keyset(&[], &access.identity)?;
    let wrapped = encode(&c::wrap(&access.master, space, Purpose::Workspace, &set)?)?;
    let device = SigningKey::from_bytes(&access.device_key);
    let proof = device.sign(&space_key_message(access.account, space, &wrapped)?);

    Ok(NewSpace {
        space,
        wrapped,
        proof: proof.to_bytes().to_vec(),
    })
}
