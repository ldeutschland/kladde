use super::UNKNOWN_SEQ;
use super::relay_features::Relay;
use super::relay_requests::{call, require_success, send_request};
use crate::{Error, account::Access, json_limited};
use kladde_protocol::{account::SpaceState, compat::Feature};
use reqwest::{Method, StatusCode};
use std::collections::BTreeSet;
use uuid::Uuid;

const MAX_DOCS: usize = 500_000;

const MAX_BLOBS: usize = 500_000;

const STATE_LIMIT: usize = 48_000_000;

pub async fn remote_state(client: &reqwest::Client, access: &Access) -> Result<SpaceState, Error> {
    remote_changes(client, access, 0, &Relay::default()).await
}

pub(super) async fn remote_changes(
    client: &reqwest::Client,
    access: &Access,
    after: i64,
    relay: &Relay,
) -> Result<SpaceState, Error> {
    if relay.lacks(Feature::State) {
        return legacy_state(client, access).await;
    }

    let path = format!("v1/spaces/{}/state?after={after}", access.space);
    let response = send_request(client, access, Method::GET, &path).await?;

    if response.status() == StatusCode::NOT_FOUND {
        return legacy_state(client, access).await;
    }

    let state: SpaceState = json_limited(require_success(response)?, STATE_LIMIT).await?;

    if [
        state.docs.len(),
        state.deleted.len(),
        state.tombstones.len(),
        state.signers.len(),
    ]
    .iter()
    .any(|count| *count > MAX_DOCS)
    {
        return Err(Error::Denied);
    }

    Ok(state)
}

pub async fn remote_blobs(
    client: &reqwest::Client,
    access: &Access,
) -> Result<Option<BTreeSet<Uuid>>, Error> {
    let path = format!("v1/spaces/{}/blobs", access.space);
    let response = send_request(client, access, Method::GET, &path).await?;

    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }

    let ids: Vec<Uuid> = json_limited(require_success(response)?, STATE_LIMIT).await?;

    if ids.len() > MAX_BLOBS {
        return Err(Error::Denied);
    }

    Ok(Some(ids.into_iter().collect()))
}

async fn legacy_state(client: &reqwest::Client, access: &Access) -> Result<SpaceState, Error> {
    let path = format!("v1/spaces/{}/docs", access.space);
    let ids: Vec<Uuid> =
        json_limited(call(client, access, Method::GET, &path).await?, STATE_LIMIT).await?;
    if ids.len() > MAX_DOCS {
        return Err(Error::Denied);
    }

    Ok(SpaceState {
        docs: ids.into_iter().map(|id| (id, UNKNOWN_SEQ)).collect(),
        deleted: Vec::new(),
        tombstones: Vec::new(),
        signers: Vec::new(),
        checkpoints: false,
        mark: None,
    })
}
