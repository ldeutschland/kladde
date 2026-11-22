pub mod account;
pub mod compat;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

pub const VERSION: u8 = 1;
pub const MAX_BODY: usize = 7 * 1024 * 1024;
pub const MAX_WIRE: usize = 8 * 1024 * 1024;
pub const MAX_ATTACHMENT_MIB: usize = 64;
pub const MAX_ATTACHMENT_BYTES: usize = MAX_ATTACHMENT_MIB * 1024 * 1024;
pub const MAX_ENCODED_ATTACHMENT: usize = MAX_ATTACHMENT_BYTES + 32 * 1024;
pub const MAX_HEADS: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Kind {
    Snapshot,
    Update,
    Ephemeral,
    Checkpoint,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Header {
    pub version: u8,
    pub kind: Kind,
    pub space: Uuid,
    pub doc: Uuid,
    pub epoch: u32,
    pub snapshot: Uuid,
    pub device: Uuid,
    pub counter: u64,
    pub previous: [u8; 32],
    pub nonce: [u8; 24],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Envelope {
    pub header: Header,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Certificate {
    pub version: u8,
    pub account: Uuid,
    pub device: Uuid,
    pub public: [u8; 32],
    pub signature: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Client {
    Subscribe {
        space: Uuid,
        doc: Uuid,
        last_seq: i64,
        known_snapshot: Option<Uuid>,
    },
    PushUpdate(Envelope),
    PushSnapshot {
        envelope: Envelope,
        parent: Option<Uuid>,
        covers: i64,
    },
    Ephemeral(Envelope),
    Watch {
        space: Uuid,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Server {
    Ack {
        doc: Uuid,
        seq: i64,
    },
    Item {
        seq: i64,
        envelope: Envelope,
        certificate: Certificate,
    },
    Head {
        doc: Uuid,
        seq: i64,
    },
    Ephemeral(Envelope),
    Conflict,
    Changed {
        space: Uuid,
        doc: Uuid,
        seq: i64,
    },
    Removed {
        space: Uuid,
        doc: Uuid,
    },
    Watching {
        space: Uuid,
    },
    Full,
    Outdated {
        doc: Uuid,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub covers: i64,
    pub heads: Vec<(Uuid, u64, [u8; 32])>,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
#[error("Invalid version, size or encoding")]
pub struct Invalid;

pub fn encode<T: Serialize>(v: &T) -> Result<Vec<u8>, Invalid> {
    postcard::to_allocvec(v).map_err(|_| Invalid)
}

pub fn decode<T: DeserializeOwned + Serialize>(data: &[u8]) -> Result<T, Invalid> {
    decode_bounded(data, MAX_WIRE)
}

pub fn decode_attachment<T: DeserializeOwned + Serialize>(data: &[u8]) -> Result<T, Invalid> {
    decode_bounded(data, MAX_ENCODED_ATTACHMENT)
}

fn decode_bounded<T: DeserializeOwned + Serialize>(
    data: &[u8],
    limit: usize,
) -> Result<T, Invalid> {
    if data.is_empty() || data.len() > limit {
        return Err(Invalid);
    }

    let (v, rest) = postcard::take_from_bytes::<T>(data).map_err(|_| Invalid)?;

    if !rest.is_empty() || encode(&v)? != data {
        return Err(Invalid);
    }

    Ok(v)
}

pub fn packet<T: Serialize>(v: &T) -> Result<Vec<u8>, Invalid> {
    let mut b = vec![VERSION];

    b.extend(encode(v)?);

    if b.len() > MAX_WIRE {
        return Err(Invalid);
    }

    Ok(b)
}

pub fn unpack<T: DeserializeOwned + Serialize>(b: &[u8]) -> Result<T, Invalid> {
    if b.first() != Some(&VERSION) {
        return Err(Invalid);
    }

    decode(&b[1..])
}

impl Envelope {
    pub fn validate(&self) -> Result<(), Invalid> {
        let h = &self.header;

        if h.version == 0
            || h.epoch == 0
            || h.counter == 0
            || self.body.len() < 20
            || self.body.len() > MAX_BODY
            || self.signature.len() != 64
            || [h.space, h.doc, h.device, h.snapshot]
                .iter()
                .any(|id| id.get_version_num() != 4)
        {
            return Err(Invalid);
        }

        Ok(())
    }
}
