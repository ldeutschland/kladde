use crate::Error;
use ed25519_dalek::VerifyingKey;
use kladde_crypto::{self as c, Key, Wrapped};
use kladde_protocol::Certificate;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

pub const MAX_EPOCHS: usize = 64;
const KEY: usize = 32;
const EPOCH: usize = 2 * KEY;
const FIRST_EPOCH: u32 = 1;
const TEXT_ID_PURPOSE: &[u8] = b"kladde/v1/file-text";

#[derive(Serialize, Deserialize, Clone)]
pub struct Ring {
    pub password: Wrapped,
    pub recovery: Wrapped,
    pub identity: Wrapped,
    pub agreement: Wrapped,
    pub workspace: Wrapped,
}

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct Access {
    pub origin: String,
    pub username: String,
    pub token: String,
    #[zeroize(skip)]
    pub account: Uuid,
    #[zeroize(skip)]
    pub space: Uuid,
    pub master: [u8; 32],
    pub workspace: Vec<u8>,
    pub identity: [u8; 32],
    pub device_key: [u8; 32],
    #[zeroize(skip)]
    pub cert: Certificate,
}

impl Access {
    pub fn from_json(bytes: &[u8]) -> Result<Self, Error> {
        let mut access: Access = serde_json::from_slice(bytes).map_err(|_| Error::Auth)?;
        let stored = Zeroizing::new(std::mem::take(&mut access.workspace));

        access.use_keyset(&stored)?;

        Ok(access)
    }

    pub fn use_keyset(&mut self, raw: &[u8]) -> Result<(), Error> {
        let set = keyset(raw, &self.identity)?;

        self.workspace.zeroize();
        self.workspace = set.to_vec();

        Ok(())
    }

    pub fn epoch(&self) -> u32 {
        (self.workspace.len() / EPOCH) as u32
    }

    pub fn epoch_keys(&self, epoch: u32) -> Result<(Key, VerifyingKey), Error> {
        let start = (epoch as usize).checked_sub(1).ok_or(Error::Conflict)? * EPOCH;
        let entry = self
            .workspace
            .get(start..start + EPOCH)
            .ok_or(Error::Conflict)?;
        let key = Zeroizing::new(<[u8; KEY]>::try_from(&entry[..KEY]).map_err(|_| Error::Auth)?);
        let identity = VerifyingKey::from_bytes(entry[KEY..].try_into().map_err(|_| Error::Auth)?)
            .map_err(|_| Error::Auth)?;
        Ok((key, identity))
    }

    pub fn text_id(&self, doc: Uuid, file: Uuid) -> Result<Uuid, Error> {
        let (first, _) = self.epoch_keys(FIRST_EPOCH)?;
        let context = [doc.as_bytes().as_slice(), file.as_bytes().as_slice()].concat();
        let derived = c::derive(first.as_ref(), &context, TEXT_ID_PURPOSE)?;
        let mut bytes = [0u8; 16];

        bytes.copy_from_slice(&derived[..16]);

        Ok(uuid::Builder::from_random_bytes(bytes).into_uuid())
    }
}

pub fn keyset(raw: &[u8], identity: &[u8; 32]) -> Result<Zeroizing<Vec<u8>>, Error> {
    let mut set = Zeroizing::new(Vec::with_capacity(raw.len().max(EPOCH)));

    set.extend_from_slice(raw);

    if raw.len() == KEY {
        set.extend_from_slice(identity);
    }

    let epochs = set.len() / EPOCH;

    if !set.len().is_multiple_of(EPOCH)
        || !(1..=MAX_EPOCHS).contains(&epochs)
        || set[set.len() - KEY..] != identity[..]
    {
        return Err(Error::Auth);
    }

    Ok(set)
}

pub fn extend_keyset(set: &[u8], identity: &[u8; 32]) -> Result<Zeroizing<Vec<u8>>, Error> {
    if !set.len().is_multiple_of(EPOCH) || set.len() / EPOCH >= MAX_EPOCHS {
        return Err(Error::Conflict);
    }

    let mut next = Zeroizing::new(Vec::with_capacity(set.len() + EPOCH));

    next.extend_from_slice(set);
    next.extend_from_slice(c::key().as_ref());
    next.extend_from_slice(identity);

    Ok(next)
}
