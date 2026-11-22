use crate::{Invalid, Key, derive};
use chacha20poly1305::{
    XChaCha20Poly1305,
    aead::{
        Payload,
        stream::{DecryptorBE32, EncryptorBE32},
    },
};

use uuid::Uuid;
use zeroize::Zeroizing;

pub const NONCE: usize = 19;
const LABEL: &[u8] = b"kladde/v2/backup";

fn stream_key(key: &Key, space: Uuid) -> Result<Key, Invalid> {
    derive(key.as_ref(), space.as_bytes(), LABEL)
}

pub struct Sealer {
    stream: EncryptorBE32<XChaCha20Poly1305>,
    context: Vec<u8>,
}

impl Sealer {
    pub fn new(
        key: &Key,
        space: Uuid,
        nonce: &[u8; NONCE],
        context: Vec<u8>,
    ) -> Result<Self, Invalid> {
        let key = stream_key(key, space)?;

        Ok(Self {
            stream: EncryptorBE32::new(key.as_ref().into(), nonce.into()),
            context,
        })
    }

    pub fn next(&mut self, plain: &[u8]) -> Result<Vec<u8>, Invalid> {
        let payload = Payload {
            msg: plain,
            aad: &self.context,
        };

        self.stream.encrypt_next(payload).map_err(|_| Invalid)
    }

    pub fn last(self, plain: &[u8]) -> Result<Vec<u8>, Invalid> {
        let payload = Payload {
            msg: plain,
            aad: &self.context,
        };

        self.stream.encrypt_last(payload).map_err(|_| Invalid)
    }
}

pub struct Opener {
    stream: DecryptorBE32<XChaCha20Poly1305>,
    context: Vec<u8>,
}

impl Opener {
    pub fn new(
        key: &Key,
        space: Uuid,
        nonce: &[u8; NONCE],
        context: Vec<u8>,
    ) -> Result<Self, Invalid> {
        let key = stream_key(key, space)?;

        Ok(Self {
            stream: DecryptorBE32::new(key.as_ref().into(), nonce.into()),
            context,
        })
    }

    pub fn next(&mut self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, Invalid> {
        let payload = Payload {
            msg: sealed,
            aad: &self.context,
        };

        let plain = self.stream.decrypt_next(payload).map_err(|_| Invalid)?;

        Ok(Zeroizing::new(plain))
    }

    pub fn last(self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, Invalid> {
        let payload = Payload {
            msg: sealed,
            aad: &self.context,
        };

        let plain = self.stream.decrypt_last(payload).map_err(|_| Invalid)?;

        Ok(Zeroizing::new(plain))
    }
}
