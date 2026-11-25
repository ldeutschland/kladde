pub mod backup;
pub mod files;
pub mod opaque;
use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305,
    aead::{Aead, Payload},
};

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use kladde_protocol::{Certificate, Envelope, Header, MAX_BODY, VERSION, encode};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

pub type Key = Zeroizing<[u8; 32]>;

#[derive(Debug, thiserror::Error)]
#[error("Cryptographic verification failed")]
pub struct Invalid;

impl From<kladde_protocol::Invalid> for Invalid {
    fn from(_: kladde_protocol::Invalid) -> Self {
        Self
    }
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0; N];

    OsRng.fill_bytes(&mut b);

    b
}

pub fn key() -> Key {
    Zeroizing::new(random())
}

pub fn derive(input: &[u8], salt: &[u8], purpose: &[u8]) -> Result<Key, Invalid> {
    let mut k = Zeroizing::new([0; 32]);

    Hkdf::<Sha256>::new(Some(salt), input)
        .expand(purpose, k.as_mut())
        .map_err(|_| Invalid)?;
    Ok(k)
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Purpose {
    Password,
    Recovery,
    Identity,
    Agreement,
    Workspace,
    File,
    Settings,
    Backup,
    Inbox,
}

impl Purpose {
    fn label(self) -> &'static [u8] {
        match self {
            Self::Password => b"kladde/v1/account-wrap",
            Self::Recovery => b"kladde/v1/recovery-wrap",
            Self::Identity => b"kladde/v1/identity-sign",
            Self::Agreement => b"kladde/v1/identity-agree",
            Self::Workspace => b"kladde/v1/workspace",
            Self::File => b"kladde/v1/file",
            Self::Settings => b"kladde/v1/settings",
            Self::Backup => b"kladde/v1/backup",
            Self::Inbox => b"kladde/v1/clip-inbox",
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Wrapped {
    version: u8,
    nonce: [u8; 24],
    body: Vec<u8>,
}

pub fn wrap(input: &[u8], id: Uuid, purpose: Purpose, plain: &[u8]) -> Result<Wrapped, Invalid> {
    let key = derive(input, id.as_bytes(), purpose.label())?;
    let nonce = random();
    let aad = encode(&(VERSION, id, purpose))?;
    let body = XChaCha20Poly1305::new(key.as_ref().into())
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: plain,
                aad: &aad,
            },
        )
        .map_err(|_| Invalid)?;
    Ok(Wrapped {
        version: VERSION,
        nonce,
        body,
    })
}

pub fn unwrap(
    input: &[u8],
    id: Uuid,
    purpose: Purpose,
    data: &Wrapped,
) -> Result<Zeroizing<Vec<u8>>, Invalid> {
    if data.version != VERSION {
        return Err(Invalid);
    }

    let key = derive(input, id.as_bytes(), purpose.label())?;
    let aad = encode(&(VERSION, id, purpose))?;

    XChaCha20Poly1305::new(key.as_ref().into())
        .decrypt(
            (&data.nonce).into(),
            Payload {
                msg: &data.body,
                aad: &aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| Invalid)
}

pub fn recovery(key: &Key) -> Result<Zeroizing<String>, Invalid> {
    bip39::Mnemonic::from_entropy(key.as_ref())
        .map(|m| Zeroizing::new(m.to_string()))
        .map_err(|_| Invalid)
}

pub fn recover(words: &str) -> Result<Key, Invalid> {
    let m = bip39::Mnemonic::parse_in(bip39::Language::English, words).map_err(|_| Invalid)?;

    if m.word_count() != 24 {
        return Err(Invalid);
    }

    let entropy = Zeroizing::new(m.to_entropy());

    Ok(Zeroizing::new(
        entropy.as_slice().try_into().map_err(|_| Invalid)?,
    ))
}

pub fn certify(
    identity: &SigningKey,
    account: Uuid,
    device: Uuid,
    public: [u8; 32],
) -> Result<Certificate, Invalid> {
    let sig = identity.sign(&encode(&(
        b"kladde/v1/device",
        VERSION,
        account,
        device,
        public,
    ))?);

    Ok(Certificate {
        version: VERSION,
        account,
        device,
        public,
        signature: sig.to_bytes().to_vec(),
    })
}

pub fn device_key(
    identity: &VerifyingKey,
    account: Uuid,
    cert: &Certificate,
) -> Result<VerifyingKey, Invalid> {
    if cert.version != VERSION || cert.account != account || cert.device.get_version_num() != 4 {
        return Err(Invalid);
    }

    let sig = Signature::from_slice(&cert.signature).map_err(|_| Invalid)?;

    identity
        .verify_strict(
            &encode(&(
                b"kladde/v1/device",
                VERSION,
                account,
                cert.device,
                cert.public,
            ))?,
            &sig,
        )
        .map_err(|_| Invalid)?;
    VerifyingKey::from_bytes(&cert.public).map_err(|_| Invalid)
}

pub fn verify_certified(
    identity: &VerifyingKey,
    account: Uuid,
    cert: &Certificate,
    message: &[u8],
    signature: &[u8],
) -> Result<(), Invalid> {
    let signature = Signature::from_slice(signature).map_err(|_| Invalid)?;

    device_key(identity, account, cert)?
        .verify_strict(message, &signature)
        .map_err(|_| Invalid)
}

const TAG: usize = 16;
pub const MAX_PLAIN: usize = 7_208_956;

fn padded(len: usize) -> Result<usize, Invalid> {
    if len > MAX_PLAIN {
        return Err(Invalid);
    }

    let n = len + 4;
    let e = n.ilog2();
    let s = e.ilog2() + 1;
    let mask = (1usize << e.saturating_sub(s)) - 1;
    let size = (n + mask) & !mask;

    if size + TAG > MAX_BODY {
        return Err(Invalid);
    }

    Ok(size)
}

pub fn seal(
    workspace: &Key,
    device: &SigningKey,
    mut header: Header,
    plain: &[u8],
) -> Result<Envelope, Invalid> {
    header.nonce = random();
    let doc = derive(workspace.as_ref(), header.doc.as_bytes(), b"kladde/v1/doc")?;
    let mut message = Zeroizing::new(vec![0; padded(plain.len())?]);

    message[..4].copy_from_slice(&(plain.len() as u32).to_be_bytes());
    message[4..4 + plain.len()].copy_from_slice(plain);
    let mut signed = encode(&header)?;
    let body = XChaCha20Poly1305::new(doc.as_ref().into())
        .encrypt(
            (&header.nonce).into(),
            Payload {
                msg: &message,
                aad: &signed,
            },
        )
        .map_err(|_| Invalid)?;
    signed.extend_from_slice(&body);
    let envelope = Envelope {
        header,
        body,
        signature: device.sign(&signed).to_bytes().to_vec(),
    };

    envelope.validate()?;

    Ok(envelope)
}

pub fn verify_envelope(envelope: &Envelope, device: &VerifyingKey) -> Result<(), Invalid> {
    let mut signed = encode(&envelope.header)?;

    signed.extend_from_slice(&envelope.body);
    device
        .verify_strict(
            &signed,
            &Signature::from_slice(&envelope.signature).map_err(|_| Invalid)?,
        )
        .map_err(|_| Invalid)
}

pub struct Expected {
    pub space: Uuid,
    pub doc: Uuid,
    pub epoch: u32,
    pub account: Uuid,
    pub counter: u64,
    pub previous: [u8; 32],
}

pub fn open(
    envelope: &Envelope,
    workspace: &Key,
    identity: &VerifyingKey,
    cert: &Certificate,
    expected: &Expected,
) -> Result<Zeroizing<Vec<u8>>, Invalid> {
    envelope.validate()?;
    let h = &envelope.header;

    if h.space != expected.space
        || h.doc != expected.doc
        || h.epoch != expected.epoch
        || h.counter != expected.counter
        || h.previous != expected.previous
        || h.device != cert.device
    {
        return Err(Invalid);
    }

    verify_envelope(envelope, &device_key(identity, expected.account, cert)?)?;
    let aad = encode(h)?;
    let key = derive(workspace.as_ref(), h.doc.as_bytes(), b"kladde/v1/doc")?;
    let mut bytes = Zeroizing::new(
        XChaCha20Poly1305::new(key.as_ref().into())
            .decrypt(
                (&h.nonce).into(),
                Payload {
                    msg: &envelope.body,
                    aad: &aad,
                },
            )
            .map_err(|_| Invalid)?,
    );
    let n = u32::from_be_bytes(
        bytes
            .get(..4)
            .ok_or(Invalid)?
            .try_into()
            .map_err(|_| Invalid)?,
    ) as usize;

    if n > bytes.len() - 4 || padded(n)? != bytes.len() {
        return Err(Invalid);
    }

    bytes.copy_within(4..4 + n, 0);
    bytes.truncate(n);

    Ok(bytes)
}

pub fn hash(e: &Envelope) -> Result<[u8; 32], Invalid> {
    Ok(Sha256::digest(encode(e)?).into())
}

pub fn backup_key(password: &[u8], salt: &[u8; 16]) -> Result<Key, Invalid> {
    if !(12..=1024).contains(&password.len()) {
        return Err(Invalid);
    }

    let mut key = Zeroizing::new([0; 32]);

    opaque::ksf()?
        .hash_password_into(password, salt, key.as_mut())
        .map_err(|_| Invalid)?;
    Ok(key)
}
