use crate::Error;
use ed25519_dalek::{Signature, VerifyingKey};
use kladde_crypto as c;
use kladde_protocol::{
    self as p, Certificate,
    account::{ChainHead, Closing, closing_message},
};

use std::collections::BTreeSet;
use uuid::Uuid;

fn signed(account: Uuid, space: Uuid, identity: &VerifyingKey, closing: &Closing) -> bool {
    let Ok(message) = closing_message(account, space, &c::digest(&closing.heads)) else {
        return false;
    };

    match &closing.signer {
        Some(cert) => {
            c::verify_certified(identity, account, cert, &message, &closing.proof).is_ok()
        }
        None => Signature::from_slice(&closing.proof)
            .is_ok_and(|signature| identity.verify_strict(&message, &signature).is_ok()),
    }
}

pub(crate) fn listed_heads(
    account: Uuid,
    space: Uuid,
    identity: &VerifyingKey,
    lists: &[Closing],
) -> BTreeSet<ChainHead> {
    lists
        .iter()
        .filter(|list| signed(account, space, identity, list))
        .filter_map(|list| p::decode_attachment::<Vec<ChainHead>>(&list.heads).ok())
        .flatten()
        .collect()
}

pub(crate) fn current_devices(
    identity: &VerifyingKey,
    account: Uuid,
    signers: &[Certificate],
) -> BTreeSet<Uuid> {
    signers
        .iter()
        .filter(|cert| c::device_key(identity, account, cert).is_ok())
        .map(|cert| cert.device)
        .collect()
}

pub(crate) fn rotation_heads(
    account: Uuid,
    space: Uuid,
    identity: &VerifyingKey,
    current: &BTreeSet<Uuid>,
    relayed: &[u8],
    lists: &[Closing],
) -> Result<Vec<u8>, Error> {
    let relayed: Vec<ChainHead> = p::decode_attachment(relayed)?;
    let mut heads = listed_heads(account, space, identity, lists);

    heads.extend(
        relayed
            .into_iter()
            .filter(|(_, device, ..)| current.contains(device)),
    );

    Ok(p::encode(&heads.into_iter().collect::<Vec<_>>())?)
}
