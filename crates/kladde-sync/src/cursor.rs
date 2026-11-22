use crate::{Error, account};
use ed25519_dalek::SigningKey;
use kladde_crypto::{self as c, Expected};
use kladde_protocol::{
    self as p, Certificate, Checkpoint, Client as Request, Envelope, Header, Kind, compat,
};

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Cursor {
    pub seq: i64,
    pub heads: BTreeMap<Uuid, (u64, [u8; 32])>,
    pub snapshot: Option<Uuid>,
    pub updates: u32,
    pub bytes: u64,
    pub epoch: u32,
}

#[derive(Serialize, Deserialize)]
struct LegacyCursor {
    seq: i64,
    heads: BTreeMap<Uuid, (u64, [u8; 32])>,
    snapshot: Option<Uuid>,
    updates: u32,
    bytes: u64,
}

impl Cursor {
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        if let Ok(cursor) = p::decode::<Cursor>(bytes) {
            return Ok(cursor);
        }

        let old: LegacyCursor = p::decode(bytes)?;

        Ok(Self {
            epoch: u32::from(old.seq > 0),
            seq: old.seq,
            heads: old.heads,
            snapshot: old.snapshot,
            updates: old.updates,
            bytes: old.bytes,
        })
    }

    pub fn next(&self, author: Uuid) -> Result<(u64, [u8; 32]), Error> {
        let (last, hash) = self.heads.get(&author).copied().unwrap_or_default();

        Ok((last.checked_add(1).ok_or(Error::Conflict)?, hash))
    }

    pub fn needs_rekey_snapshot(&self, access: &account::Access) -> bool {
        self.seq > 0 && self.epoch < access.epoch()
    }

    pub fn accept(
        &mut self,
        access: &account::Access,
        doc: Uuid,
        seq: i64,
        envelope: &Envelope,
        cert: &Certificate,
    ) -> Result<Zeroizing<Vec<u8>>, Error> {
        let header = &envelope.header;
        let jump = self.check_sequence(header, seq)?;
        let (key, identity) = access.epoch_keys(header.epoch)?;
        let open = |link| {
            let expected = expected_link(access, doc, header.epoch, link);

            c::open(envelope, &key, &identity, cert, &expected)
        };

        if header.kind != Kind::Checkpoint {
            let plain = open(self.next(header.device)?)?;

            self.advance(seq, envelope)?;

            return Ok(plain);
        }

        let plain = open((header.counter, header.previous))?;

        self.adopt_checkpoint(&plain, seq, envelope, jump)
    }

    fn check_sequence(&self, header: &Header, seq: i64) -> Result<bool, Error> {
        if header.version > compat::FORMAT {
            return Err(Error::Newer);
        }

        let next = self.seq.checked_add(1).ok_or(Error::Conflict)?;
        let jump = seq != next;

        if (jump && (header.kind != Kind::Checkpoint || seq < next))
            || header.kind == Kind::Ephemeral
            || header.kind == Kind::Update && self.snapshot != Some(header.snapshot)
            || header.epoch < self.epoch
        {
            return Err(Error::Conflict);
        }

        Ok(jump)
    }

    fn adopt_checkpoint(
        &mut self,
        plain: &[u8],
        seq: i64,
        envelope: &Envelope,
        jump: bool,
    ) -> Result<Zeroizing<Vec<u8>>, Error> {
        let header = &envelope.header;
        let point: Checkpoint = p::decode(plain)?;
        let heads = handover(&point, seq)?;

        self.check_handover(&heads, jump)?;
        let (last, previous) = heads.get(&header.device).copied().unwrap_or_default();

        if last.checked_add(1) != Some(header.counter) || previous != header.previous {
            return Err(Error::Conflict);
        }

        self.heads = heads;
        self.advance(seq, envelope)?;

        Ok(Zeroizing::new(point.data))
    }

    fn check_handover(&self, heads: &Heads, jump: bool) -> Result<(), Error> {
        if !jump {
            return if *heads == self.heads {
                Ok(())
            } else {
                Err(Error::Conflict)
            };
        }

        for (device, (counter, hash)) in &self.heads {
            let Some((later, later_hash)) = heads.get(device) else {
                return Err(Error::Conflict);
            };

            if later < counter || (later == counter && later_hash != hash) {
                return Err(Error::Conflict);
            }
        }

        Ok(())
    }

    fn advance(&mut self, seq: i64, envelope: &Envelope) -> Result<(), Error> {
        let header = &envelope.header;

        self.heads
            .insert(header.device, (header.counter, c::hash(envelope)?));
        self.seq = seq;
        self.epoch = header.epoch;

        if header.kind == Kind::Update {
            self.updates = self.updates.saturating_add(1);
            self.bytes = self.bytes.saturating_add(envelope.body.len() as u64);
        } else {
            self.snapshot = Some(header.snapshot);
            self.updates = 0;
            self.bytes = 0;
        }

        Ok(())
    }

    pub fn push(&self, access: &account::Access, doc: Uuid, data: &[u8]) -> Result<Request, Error> {
        self.push_with(access, doc, data, false)
    }

    pub fn push_with(
        &self,
        access: &account::Access,
        doc: Uuid,
        data: &[u8],
        checkpoints: bool,
    ) -> Result<Request, Error> {
        let writing = Writing {
            checkpoints,
            format: compat::FORMAT,
        };

        self.push_as(access, doc, data, writing)
    }

    pub fn push_as(
        &self,
        access: &account::Access,
        doc: Uuid,
        data: &[u8],
        writing: Writing,
    ) -> Result<Request, Error> {
        let epoch = access.epoch();

        if self.epoch > epoch {
            return Err(Error::Conflict);
        }

        let snapshot = self.needs_snapshot(epoch);
        let kind = push_kind(
            snapshot,
            writing.checkpoints && self.heads.len() <= p::MAX_HEADS,
        );
        let header = self.push_header(access, doc, kind, writing.format, snapshot)?;
        let plain = self.payload(kind, data)?;
        let (key, _) = access.epoch_keys(epoch)?;
        let signer = SigningKey::from_bytes(&access.device_key);
        let envelope = c::seal(&key, &signer, header, &plain)?;

        Ok(if snapshot {
            Request::PushSnapshot {
                envelope,
                parent: self.snapshot,
                covers: self.seq,
            }
        } else {
            Request::PushUpdate(envelope)
        })
    }

    fn needs_snapshot(&self, epoch: u32) -> bool {
        self.snapshot.is_none()
            || self.epoch < epoch
            || self.updates >= SNAPSHOT_UPDATES
            || self.bytes >= SNAPSHOT_BYTES
    }

    fn push_header(
        &self,
        access: &account::Access,
        doc: Uuid,
        kind: Kind,
        format: u8,
        snapshot: bool,
    ) -> Result<Header, Error> {
        let (counter, previous) = self.next(access.cert.device)?;

        Ok(Header {
            version: format,
            kind,
            space: access.space,
            doc,
            epoch: access.epoch(),
            snapshot: if snapshot {
                Uuid::new_v4()
            } else {
                self.snapshot.ok_or(Error::Conflict)?
            },
            device: access.cert.device,
            counter,
            previous,
            nonce: [0; 24],
        })
    }

    fn payload(&self, kind: Kind, data: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
        if kind != Kind::Checkpoint {
            return Ok(Zeroizing::new(data.to_vec()));
        }

        let point = Checkpoint {
            covers: self.seq,
            heads: self
                .heads
                .iter()
                .map(|(device, (counter, hash))| (*device, *counter, *hash))
                .collect(),
            data: data.to_vec(),
        };

        let encoded = Zeroizing::new(p::encode(&point)?);

        drop(Zeroizing::new(point.data));

        Ok(encoded)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Writing {
    pub checkpoints: bool,
    pub format: u8,
}

type Heads = BTreeMap<Uuid, (u64, [u8; 32])>;
const SNAPSHOT_UPDATES: u32 = 64;
const SNAPSHOT_BYTES: u64 = 524288;

fn handover(point: &Checkpoint, seq: i64) -> Result<Heads, Error> {
    if point.covers.checked_add(1) != Some(seq)
        || point.heads.len() > p::MAX_HEADS
        || point.heads.windows(2).any(|pair| pair[0].0 >= pair[1].0)
        || point.heads.iter().any(|(_, counter, _)| *counter == 0)
    {
        return Err(Error::Conflict);
    }

    Ok(point
        .heads
        .iter()
        .map(|(device, counter, hash)| (*device, (*counter, *hash)))
        .collect())
}

fn expected_link(
    access: &account::Access,
    doc: Uuid,
    epoch: u32,
    (counter, previous): (u64, [u8; 32]),
) -> Expected {
    Expected {
        space: access.space,
        doc,
        epoch,
        account: access.account,
        counter,
        previous,
    }
}

fn push_kind(snapshot: bool, checkpoints_allowed: bool) -> Kind {
    match (snapshot, checkpoints_allowed) {
        (false, _) => Kind::Update,
        (true, false) => Kind::Snapshot,
        (true, true) => Kind::Checkpoint,
    }
}
