use super::Certificate;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct AccountBundle {
    pub version: u8,
    pub ksf: u8,
    pub account: Uuid,
    pub space: Uuid,
    pub identity: [u8; 32],
    pub recovery_public: [u8; 32],
    pub keys: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    pub user: String,
    pub message: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
pub struct Reply {
    pub challenge: Uuid,
    pub message: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Register {
    pub user: String,
    pub record: Vec<u8>,
    pub bundle: AccountBundle,
}

#[derive(Serialize, Deserialize)]
pub struct Login {
    pub challenge: Uuid,
    pub message: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
pub struct GetKeys {
    pub ticket: String,
    pub bundle: AccountBundle,
}

#[derive(Serialize, Deserialize)]
pub struct Enroll {
    pub ticket: String,
    pub cert: Certificate,
    pub proof: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
pub struct Session {
    pub token: String,
}

#[derive(Serialize, Deserialize)]
pub struct RecoveryStart {
    pub user: String,
}

#[derive(Serialize, Deserialize)]
pub struct RecoveryChallenge {
    pub nonce: Uuid,
    pub account: Uuid,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveryKeys {
    pub nonce: Uuid,
    pub proof: Vec<u8>,
}

pub fn recovery_keys_message(nonce: Uuid, account: Uuid) -> Result<Vec<u8>, super::Invalid> {
    super::encode(&(b"kladde/v1/recovery-keys", nonce, account))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewSpace {
    pub space: Uuid,
    pub wrapped: Vec<u8>,
    pub proof: Vec<u8>,
}

pub fn space_key_message(
    account: Uuid,
    space: Uuid,
    wrapped: &[u8],
) -> Result<Vec<u8>, super::Invalid> {
    super::encode(&(b"kladde/v1/space-key", account, space, wrapped))
}

pub fn remove_space_message(account: Uuid, space: Uuid) -> Result<Vec<u8>, super::Invalid> {
    super::encode(&(b"kladde/v1/remove-space", account, space))
}

pub const PROOF_HEADER: &str = "kladde-proof";

pub fn purge_message(account: Uuid, space: Uuid, doc: Uuid) -> Result<Vec<u8>, super::Invalid> {
    super::encode(&(b"kladde/v1/purge", account, space, doc))
}

pub fn discard_message(
    account: Uuid,
    space: Uuid,
    owner: Uuid,
    ids: &[Uuid],
) -> Result<Vec<u8>, super::Invalid> {
    super::encode(&(b"kladde/v1/discard", account, space, owner, ids))
}

pub fn erase_blob_message(
    account: Uuid,
    space: Uuid,
    blob: Uuid,
) -> Result<Vec<u8>, super::Invalid> {
    super::encode(&(b"kladde/v1/erase-blob", account, space, blob))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Erase {
    pub ticket: String,
}

pub type ChainHead = (Uuid, Uuid, u64, [u8; 32]);

#[derive(Serialize, Deserialize, Clone)]
pub struct SpaceHeads {
    pub space: Uuid,
    pub mark: i64,
    pub heads: Vec<u8>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ClosingProof {
    pub space: Uuid,
    pub mark: i64,
    pub digest: [u8; 32],
    pub proof: Vec<u8>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Closing {
    pub signer: Option<Certificate>,
    pub heads: Vec<u8>,
    pub proof: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceClosing {
    pub heads: Vec<u8>,
    pub proof: Vec<u8>,
}

pub fn closing_message(
    account: Uuid,
    space: Uuid,
    digest: &[u8; 32],
) -> Result<Vec<u8>, super::Invalid> {
    super::encode(&(b"kladde/v1/closing", account, space, digest))
}

#[derive(Serialize, Deserialize)]
pub struct RecoveryInfo {
    pub nonce: Uuid,
    pub bundle: AccountBundle,
    pub spaces: Vec<(Uuid, Vec<u8>)>,
    #[serde(default)]
    pub heads: Vec<SpaceHeads>,
}

#[derive(Serialize, Deserialize)]
pub struct Reset {
    pub login_ticket: Option<String>,
    pub nonce: Uuid,
    pub record: Vec<u8>,
    pub bundle: AccountBundle,
    pub spaces: Vec<(Uuid, Vec<u8>)>,
    pub proof: Vec<u8>,
    #[serde(default)]
    pub closings: Vec<ClosingProof>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenewStart {
    pub device: Uuid,
}

#[derive(Serialize, Deserialize)]
pub struct RenewChallenge {
    pub challenge: Uuid,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Renew {
    pub challenge: Uuid,
    pub proof: Vec<u8>,
}

pub fn renew_message(challenge: Uuid, device: Uuid) -> Result<Vec<u8>, super::Invalid> {
    super::encode(&(b"kladde/v1/renew", challenge, device))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Tombstone {
    pub doc: Uuid,
    pub device: Uuid,
    pub proof: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
pub struct SpaceState {
    pub docs: Vec<(Uuid, i64)>,
    pub deleted: Vec<Uuid>,
    #[serde(default)]
    pub tombstones: Vec<Tombstone>,
    #[serde(default)]
    pub signers: Vec<Certificate>,
    #[serde(default)]
    pub checkpoints: bool,
    #[serde(default)]
    pub mark: Option<i64>,
}
