use super::Local;
use super::relay_requests::{call, require_success};
use super::report::Report;
use crate::{Error, Origin, account::Access, json_limited};
use kladde_protocol::{
    self as p,
    compat::{self, Feature, Hello, Refusal},
};

use reqwest::{Method, StatusCode};
use std::collections::BTreeSet;
use uuid::Uuid;

const HELLO_LIMIT: usize = 16_384;

const MAX_DEVICES: usize = 4096;

const DEVICES_LIMIT: usize = 262_144;

const SERVER_BEHIND: &str = "server";

const DEVICE_BEHIND: &str = "device";

#[derive(Default)]
pub struct Relay {
    offered: Option<BTreeSet<Feature>>,
    behind: bool,
}

impl Relay {
    pub fn offers(&self, feature: Feature) -> bool {
        self.offered.as_ref().is_some_and(|f| f.contains(&feature))
    }

    pub(super) fn lacks(&self, feature: Feature) -> bool {
        self.offered.as_ref().is_some_and(|f| !f.contains(&feature))
    }
}

pub async fn handshake(client: &reqwest::Client, access: &Access) -> Result<Relay, Error> {
    let url = Origin::parse(&access.origin)?
        .0
        .join("v1/hello")
        .map_err(|_| Error::Url)?;
    let response = client.get(url).send().await.map_err(|_| Error::Network)?;

    if response.status() == StatusCode::NOT_FOUND {
        return Ok(Relay {
            offered: None,
            behind: true,
        });
    }

    let hello: Hello = json_limited(require_success(response)?, HELLO_LIMIT).await?;
    let offered = hello.offered().map_err(|refusal| match refusal {
        Refusal::Invalid => Error::Protocol(p::Invalid),
        Refusal::Outdated(side) => Error::Outdated(side),
    })?;

    Ok(Relay {
        offered: Some(offered),
        behind: hello.behind(),
    })
}

async fn device_formats(client: &reqwest::Client, access: &Access) -> Result<Vec<u8>, Error> {
    let response = call(client, access, Method::GET, "v1/devices/formats").await?;
    let devices: Vec<(Uuid, u8)> = json_limited(response, DEVICES_LIMIT).await?;

    if devices.len() > MAX_DEVICES {
        return Err(Error::Denied);
    }

    let own = access.cert.device;

    Ok(devices
        .into_iter()
        .filter(|(device, _)| *device != own)
        .map(|(_, format)| format)
        .collect())
}

fn format_key(access: &Access) -> String {
    format!("relay:{}:format", access.account)
}

pub(super) fn known_format(local: &impl Local, access: &Access) -> Result<u8, Error> {
    let stored = local.with(|store| store.state(&format_key(access)))?;
    let format = stored.and_then(|bytes| bytes.first().copied());

    Ok(format.map_or(compat::LEGACY_FORMAT, |f| {
        f.clamp(compat::LEGACY_FORMAT, compat::FORMAT)
    }))
}

async fn writable_format(
    client: &reqwest::Client,
    access: &Access,
    relay: &Relay,
) -> Result<u8, Error> {
    if !relay.offers(Feature::Formats) {
        return Ok(compat::LEGACY_FORMAT);
    }

    match device_formats(client, access).await {
        Ok(others) => Ok(compat::shared_format(others)),
        Err(Error::Denied | Error::Protocol(_)) => Ok(compat::LEGACY_FORMAT),
        Err(e) => Err(e),
    }
}

pub(super) async fn agree_on_format(
    local: &impl Local,
    client: &reqwest::Client,
    access: &Access,
    relay: &Relay,
    report: &mut Report,
) -> Result<(), Error> {
    let format = writable_format(client, access, relay).await?;
    let lagging = [
        (relay.behind, SERVER_BEHIND),
        (
            relay.offers(Feature::Formats) && format < compat::FORMAT,
            DEVICE_BEHIND,
        ),
    ];
    let behind = lagging.into_iter().filter(|(lags, _)| *lags);

    report.behind = Some(behind.map(|(_, side)| side).collect());

    local.with(|store| store.set_state(&format_key(access), &[format]))
}

pub(super) fn checkpoints_key(access: &Access) -> String {
    format!("relay:{}:checkpoints", access.account)
}

pub(super) fn remember_checkpoints(
    local: &impl Local,
    access: &Access,
    supported: bool,
) -> Result<(), Error> {
    let key = checkpoints_key(access);

    local.with(|store| match supported {
        true => store.set_state(&key, &[1]),
        false => store.clear_state(&key),
    })
}
