use super::{
    access::{Access, Ring, extend_keyset},
    credentials::{check_bundle, check_user, open_ring},
    fresh_keys::{Fresh, recovery_signer},
    login::unlock,
    registration::new_record,
    space_keys::{SpaceKeys, open_space},
};

use crate::{Error, Origin, post};
use ed25519_dalek::{Signer, SigningKey};
use kladde_crypto::{self as c, Key, Purpose};
use kladde_protocol::{account::*, decode, encode};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

fn open_spaces(auth: &Authorized) -> Result<Vec<SpaceKeys>, Error> {
    let identity = &auth.info.bundle.identity;
    let repairs = auth.ticket.is_none();
    let mut opened = Vec::with_capacity(auth.info.spaces.len());

    for (space, raw) in &auth.info.spaces {
        match open_space(&auth.master, identity, *space, raw) {
            Ok(set) => opened.push((*space, set)),
            Err(_) if repairs => {}
            Err(_) => return Err(Error::Unreadable),
        }
    }

    Ok(opened)
}

pub enum Proof<'a> {
    Password(&'a str),
    Recovery(&'a str),
}

struct Authorized {
    info: RecoveryInfo,
    master: Zeroizing<Vec<u8>>,
    ticket: Option<String>,
    signer: SigningKey,
}

async fn recovery_info(
    client: &Client,
    origin: &Origin,
    user: &str,
    signer_for: impl FnOnce(Uuid) -> Result<SigningKey, Error>,
) -> Result<(RecoveryInfo, SigningKey), Error> {
    let start: RecoveryChallenge = post(
        client,
        origin,
        "v1/recovery/start",
        &RecoveryStart { user: user.into() },
    )
    .await?;
    let signer = signer_for(start.account)?;
    let proof = signer
        .sign(&recovery_keys_message(start.nonce, start.account)?)
        .to_bytes()
        .to_vec();
    let keys = RecoveryKeys {
        nonce: start.nonce,
        proof,
    };

    let info: RecoveryInfo = post(client, origin, "v1/recovery/keys", &keys).await?;

    check_bundle(&info.bundle)?;

    if info.bundle.account != start.account {
        return Err(Error::Auth);
    }

    Ok((info, signer))
}

async fn authorize_password(
    client: &Client,
    origin: &Origin,
    user: &str,
    password: &str,
) -> Result<Authorized, Error> {
    let (keys, master) = unlock(client, origin, user, password).await?;
    let (identity, _) = open_ring(&keys.bundle, &master)?;
    let account = keys.bundle.account;
    let identity_of = |claimed| match claimed == account {
        true => Ok(identity),
        false => Err(Error::Conflict),
    };

    let (info, signer) = recovery_info(client, origin, user, identity_of).await?;

    if encode(&keys.bundle)? != encode(&info.bundle)? {
        return Err(Error::Conflict);
    }

    Ok(Authorized {
        info,
        master,
        ticket: Some(keys.ticket),
        signer,
    })
}

async fn authorize_recovery(
    client: &Client,
    origin: &Origin,
    user: &str,
    words: &str,
) -> Result<Authorized, Error> {
    let recovery = c::recover(words)?;
    let phrase_signer = |account| recovery_signer(&recovery, account);
    let (info, signer) = recovery_info(client, origin, user, phrase_signer).await?;
    let bundle = &info.bundle;

    if signer.verifying_key().to_bytes() != bundle.recovery_public {
        return Err(Error::Auth);
    }

    let ring: Ring = decode(&bundle.keys)?;
    let master = c::unwrap(
        recovery.as_ref(),
        bundle.account,
        Purpose::Recovery,
        &ring.recovery,
    )?;

    Ok(Authorized {
        info,
        master,
        ticket: None,
        signer,
    })
}

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct Expected {
    origin: String,
    username: String,
    #[zeroize(skip)]
    account: Uuid,
    identity: [u8; 32],
    workspace: Vec<u8>,
}

impl Expected {
    pub fn from_json(bytes: &[u8]) -> Result<Self, Error> {
        serde_json::from_slice(bytes).map_err(|_| Error::Auth)
    }

    pub fn covers(&self, origin: &str, username: &str) -> bool {
        self.origin == origin && self.username == username
    }

    pub fn confirmed_by(&self, access: &Access) -> bool {
        self.covers(&access.origin, &access.username)
            && self.account == access.account
            && self.identity == access.identity
            && self.workspace == access.workspace
    }
}

pub struct Known {
    pub account: Uuid,
    pub workspace: Zeroizing<Vec<u8>>,
    pub spaces: Vec<SpaceKeys>,
}

struct Relayed {
    workspace: Zeroizing<Vec<u8>>,
    spaces: Vec<SpaceKeys>,
}

pub struct Rotation {
    reset: Reset,
    pub expected: Expected,
    relayed: Relayed,
}

fn space_continues(relayed: &[SpaceKeys], space: Uuid, known: &[u8]) -> bool {
    relayed
        .iter()
        .any(|(id, set)| *id == space && set.starts_with(known))
}

impl Rotation {
    pub fn continues(&self, known: &Known) -> Result<(), Error> {
        if known.account != self.expected.account
            || !self.relayed.workspace.starts_with(&known.workspace)
            || !known
                .spaces
                .iter()
                .all(|(space, set)| space_continues(&self.relayed.spaces, *space, set))
        {
            return Err(Error::Conflict);
        }

        Ok(())
    }

    pub async fn send(self, client: &Client, origin: &Origin) -> Result<Expected, Error> {
        let _: bool = post(client, origin, "v1/recovery/finish", &self.reset).await?;

        Ok(self.expected)
    }
}

fn signed_reset(
    auth: &Authorized,
    record: Vec<u8>,
    bundle: AccountBundle,
    spaces: Vec<(Uuid, Vec<u8>)>,
) -> Result<Reset, Error> {
    let nonce = auth.info.nonce;
    let signed = encode(&(
        b"kladde/v1/rekey",
        nonce,
        &auth.ticket,
        &record,
        &bundle,
        &spaces,
    ))?;

    Ok(Reset {
        nonce,
        login_ticket: auth.ticket.clone(),
        record,
        bundle,
        spaces,
        proof: auth.signer.sign(&signed).to_bytes().to_vec(),
    })
}

pub async fn prepare_rekey(
    client: &Client,
    origin: &Origin,
    user: &str,
    proof: Proof<'_>,
    password: &str,
    recovery: &Key,
) -> Result<Rotation, Error> {
    check_user(user, password)?;
    let auth = match proof {
        Proof::Password(old) => authorize_password(client, origin, user, old).await?,
        Proof::Recovery(words) => authorize_recovery(client, origin, user, words).await?,
    };

    let old = &auth.info.bundle;
    let (_, relayed) = open_ring(old, &auth.master)?;
    let fresh = Fresh::new();
    let workspace = extend_keyset(&relayed, &fresh.public())?;
    let opened = open_spaces(&auth)?;
    let spaces = fresh.rewrap_spaces(&opened)?;
    let (record, export) = new_record(client, origin, user, password).await?;
    let ring = fresh.ring(&export, recovery, old.account, old.space, &workspace)?;
    let bundle = fresh.bundle(old.account, old.space, recovery, &ring)?;
    let expected = Expected {
        origin: origin.0.to_string(),
        username: user.into(),
        account: old.account,
        identity: fresh.public(),
        workspace: workspace.to_vec(),
    };

    Ok(Rotation {
        reset: signed_reset(&auth, record, bundle, spaces)?,
        expected,
        relayed: Relayed {
            workspace: relayed,
            spaces: opened,
        },
    })
}

pub async fn rekey(
    client: &Client,
    origin: &Origin,
    user: &str,
    proof: Proof<'_>,
    password: &str,
    recovery: &Key,
) -> Result<Expected, Error> {
    let rotation = prepare_rekey(client, origin, user, proof, password, recovery).await?;

    rotation.send(client, origin).await
}
