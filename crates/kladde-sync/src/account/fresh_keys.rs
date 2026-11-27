use super::{
    access::{Ring, extend_keyset},
    space_keys::SpaceKeys,
};

use crate::Error;
use ed25519_dalek::{Signer, SigningKey};
use kladde_crypto::{self as c, Key, Purpose};
use kladde_protocol::{account::*, encode};
use rand::rngs::OsRng;
use uuid::Uuid;
use zeroize::Zeroizing;

pub(super) struct Fresh {
    master: Key,
    identity: SigningKey,
    agreement: x25519_dalek::StaticSecret,
}

impl Fresh {
    pub(super) fn new() -> Self {
        Self {
            master: c::key(),
            identity: SigningKey::generate(&mut OsRng),
            agreement: x25519_dalek::StaticSecret::random_from_rng(OsRng),
        }
    }

    pub(super) fn public(&self) -> [u8; 32] {
        self.identity.verifying_key().to_bytes()
    }

    pub(super) fn close(
        &self,
        account: Uuid,
        space: Uuid,
        mark: i64,
        heads: Vec<u8>,
    ) -> Result<ClosingProof, Error> {
        let message = closing_message(account, space, &c::digest(&heads))?;

        Ok(ClosingProof {
            space,
            mark,
            heads,
            proof: self.identity.sign(&message).to_bytes().to_vec(),
        })
    }

    pub(super) fn ring(
        &self,
        export: &[u8],
        recovery: &Key,
        account: Uuid,
        space: Uuid,
        workspace: &[u8],
    ) -> Result<Ring, Error> {
        let master = self.master.as_ref();
        let agreement = Zeroizing::new(self.agreement.to_bytes());

        Ok(Ring {
            password: c::wrap(export, account, Purpose::Password, master)?,
            recovery: c::wrap(recovery.as_ref(), account, Purpose::Recovery, master)?,
            identity: c::wrap(master, account, Purpose::Identity, self.identity.as_bytes())?,
            agreement: c::wrap(master, account, Purpose::Agreement, agreement.as_ref())?,
            workspace: c::wrap(master, space, Purpose::Workspace, workspace)?,
        })
    }

    pub(super) fn bundle(
        &self,
        account: Uuid,
        space: Uuid,
        recovery: &Key,
        ring: &Ring,
    ) -> Result<AccountBundle, Error> {
        Ok(AccountBundle {
            version: 1,
            ksf: 1,
            account,
            space,
            identity: self.public(),
            recovery_public: recovery_signer(recovery, account)?
                .verifying_key()
                .to_bytes(),
            keys: encode(ring)?,
        })
    }

    fn rewrap_space(&self, space: Uuid, set: &[u8]) -> Result<(Uuid, Vec<u8>), Error> {
        let next = extend_keyset(set, &self.public())?;
        let rewrapped = c::wrap(self.master.as_ref(), space, Purpose::Workspace, &next)?;

        Ok((space, encode(&rewrapped)?))
    }

    pub(super) fn rewrap_spaces(
        &self,
        opened: &[SpaceKeys],
    ) -> Result<Vec<(Uuid, Vec<u8>)>, Error> {
        opened
            .iter()
            .map(|(space, set)| self.rewrap_space(*space, set))
            .collect()
    }
}

pub(super) fn recovery_signer(recovery: &Key, account: Uuid) -> Result<SigningKey, Error> {
    Ok(SigningKey::from_bytes(&*c::derive(
        recovery.as_ref(),
        account.as_bytes(),
        b"kladde/v1/recovery-proof",
    )?))
}
