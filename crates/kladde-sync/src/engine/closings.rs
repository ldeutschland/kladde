use super::Local;
use super::doc_state_keys::{head_prefix, read_cursor};
use super::relay_requests::{call, require_success};
use crate::{Error, Origin, account::Access, closing_lists::listed_heads, json_limited};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use kladde_crypto as c;
use kladde_protocol::{
    self as p,
    account::{ChainHead, Closing, DeviceClosing, closing_message},
};

use kladde_store::Store;
use reqwest::Method;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub(super) type CoveredHead = (Uuid, u64, [u8; 32]);
pub(super) type Covered = Vec<CoveredHead>;

const CLOSINGS_LIMIT: usize = 96 * 1024 * 1024;

fn chains_prefix(access: &Access) -> String {
    format!("relay:{}:{}:chains:", access.account, access.space)
}

fn loaded_key(access: &Access) -> String {
    format!("relay:{}:{}:chains", access.account, access.space)
}

fn shared_key(access: &Access) -> String {
    format!("relay:{}:{}:chains-shared", access.account, access.space)
}

fn fresh_key(account: Uuid) -> String {
    format!("relay:{account}:fresh")
}

pub fn remember_fresh_sign_in(store: &Store, access: &Access) -> Result<(), kladde_store::Error> {
    store.set_state(&fresh_key(access.account), &access.identity)
}

pub(super) fn covered_heads(
    local: &impl Local,
    access: &Access,
    doc: Uuid,
) -> Result<Covered, Error> {
    let key = format!("{}{doc}", chains_prefix(access));

    match local.with(|store| store.state(&key))? {
        Some(bytes) => Ok(p::decode(&bytes)?),
        None => Ok(Vec::new()),
    }
}

pub(super) fn forget_chains(local: &impl Local, access: &Access) -> Result<(), Error> {
    local.with(|store| store.clear_state(&loaded_key(access)))
}

fn remembered_for(local: &impl Local, key: &str, access: &Access) -> Result<bool, Error> {
    Ok(local.with(|store| store.state(key))?.as_deref() == Some(access.identity.as_slice()))
}

pub(super) async fn ensure_chains(
    local: &impl Local,
    client: &reqwest::Client,
    access: &Access,
) -> Result<(), Error> {
    if remembered_for(local, &loaded_key(access), access)? {
        return Ok(());
    }

    if !remembered_for(local, &fresh_key(access.account), access)?
        && !remembered_for(local, &shared_key(access), access)?
    {
        tolerate_old_relay(share_own_heads(local, client, access).await)?;
    }

    let closings = tolerate_old_relay(fetch_closings(client, access).await)?.unwrap_or_default();

    store_chains(local, access, &covered_by(access, &closings)?)
}

fn tolerate_old_relay<T>(result: Result<T, Error>) -> Result<Option<T>, Error> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(Error::Denied) => Ok(None),
        Err(e) => Err(e),
    }
}

pub(super) fn own_heads(local: &impl Local, access: &Access) -> Result<Vec<ChainHead>, Error> {
    let prefix = head_prefix(access);

    local.with(|store| {
        let mut heads = Vec::new();

        for key in store.state_keys(&prefix)? {
            let Ok(doc) = key[prefix.len()..].parse::<Uuid>() else {
                continue;
            };

            let chains = read_cursor(store, &key)?.heads.into_iter();

            heads.extend(chains.map(|(device, (counter, hash))| (doc, device, counter, hash)));
        }

        heads.sort_unstable();

        Ok(heads)
    })
}

fn mark_shared(local: &impl Local, access: &Access) -> Result<(), Error> {
    local.with(|store| store.set_state(&shared_key(access), &access.identity))
}

async fn share_own_heads(
    local: &impl Local,
    client: &reqwest::Client,
    access: &Access,
) -> Result<(), Error> {
    let heads = own_heads(local, access)?;

    if heads.is_empty() {
        return mark_shared(local, access);
    }

    let bytes = p::encode(&heads)?;
    let message = closing_message(access.account, access.space, &c::digest(&bytes))?;
    let closing = DeviceClosing {
        proof: SigningKey::from_bytes(&access.device_key)
            .sign(&message)
            .to_bytes()
            .to_vec(),
        heads: bytes,
    };

    put_closing(client, access, &closing).await?;

    mark_shared(local, access)
}

async fn put_closing(
    client: &reqwest::Client,
    access: &Access,
    closing: &DeviceClosing,
) -> Result<(), Error> {
    let path = format!("v1/spaces/{}/closing", access.space);
    let url = Origin::parse(&access.origin)?
        .0
        .join(&path)
        .map_err(|_| Error::Url)?;
    let response = client
        .put(url)
        .bearer_auth(&access.token)
        .json(closing)
        .send()
        .await
        .map_err(|_| Error::Network)?;

    require_success(response)?;

    Ok(())
}

async fn fetch_closings(client: &reqwest::Client, access: &Access) -> Result<Vec<Closing>, Error> {
    let path = format!("v1/spaces/{}/closings", access.space);
    let reply = call(client, access, Method::GET, &path).await?;

    json_limited(reply, CLOSINGS_LIMIT).await
}

pub(super) fn covered_by(
    access: &Access,
    closings: &[Closing],
) -> Result<BTreeMap<Uuid, Covered>, Error> {
    let identity = VerifyingKey::from_bytes(&access.identity).map_err(|_| Error::Auth)?;
    let mut covered: BTreeMap<Uuid, Covered> = BTreeMap::new();

    for (doc, device, counter, hash) in
        listed_heads(access.account, access.space, &identity, closings)
    {
        covered
            .entry(doc)
            .or_default()
            .push((device, counter, hash));
    }

    Ok(covered)
}

pub(super) fn store_chains(
    local: &impl Local,
    access: &Access,
    covered: &BTreeMap<Uuid, Covered>,
) -> Result<(), Error> {
    let prefix = chains_prefix(access);
    let mut set = Vec::with_capacity(covered.len() + 1);

    for (doc, heads) in covered {
        set.push((format!("{prefix}{doc}"), p::encode(heads)?));
    }

    set.push((loaded_key(access), access.identity.to_vec()));
    let kept: BTreeSet<&str> = set.iter().map(|(key, _)| key.as_str()).collect();

    local.with(|store| {
        let stale: Vec<String> = store
            .state_keys(&prefix)?
            .into_iter()
            .filter(|key| !kept.contains(key.as_str()))
            .collect();
        let cleared: Vec<&str> = stale.iter().map(String::as_str).collect();
        let values: Vec<(String, &[u8])> = set
            .iter()
            .map(|(key, value)| (key.clone(), value.as_slice()))
            .collect();

        store.replace_states(&values, &cleared)
    })
}
