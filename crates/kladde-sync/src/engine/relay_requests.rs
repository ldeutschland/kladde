use crate::{Error, Origin, account::Access};
use ed25519_dalek::{Signer, SigningKey};
use kladde_protocol::account::PROOF_HEADER;
use reqwest::{Method, StatusCode};

pub fn require_success(response: reqwest::Response) -> Result<reqwest::Response, Error> {
    let status = response.status();

    if status.is_success() {
        return Ok(response);
    }

    if status == StatusCode::UPGRADE_REQUIRED {
        return Err(crate::outdated_in(response.headers()));
    }

    Err(match status {
        StatusCode::UNAUTHORIZED => Error::Auth,
        StatusCode::TOO_MANY_REQUESTS => Error::Busy,
        StatusCode::REQUEST_TIMEOUT => Error::Network,
        s if s.is_server_error() => Error::Network,
        _ => Error::Denied,
    })
}

pub(super) async fn send_request(
    client: &reqwest::Client,
    access: &Access,
    method: Method,
    path: &str,
) -> Result<reqwest::Response, Error> {
    let url = Origin::parse(&access.origin)?
        .0
        .join(path)
        .map_err(|_| Error::Url)?;
    client
        .request(method, url)
        .bearer_auth(&access.token)
        .send()
        .await
        .map_err(|_| Error::Network)
}

pub async fn call(
    client: &reqwest::Client,
    access: &Access,
    method: Method,
    path: &str,
) -> Result<reqwest::Response, Error> {
    require_success(send_request(client, access, method, path).await?)
}

pub(super) fn proof(access: &Access, message: &[u8]) -> String {
    SigningKey::from_bytes(&access.device_key)
        .sign(message)
        .to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) async fn signed_request(
    client: &reqwest::Client,
    access: &Access,
    method: Method,
    path: &str,
    message: &[u8],
) -> Result<reqwest::Response, Error> {
    let url = Origin::parse(&access.origin)?
        .0
        .join(path)
        .map_err(|_| Error::Url)?;
    client
        .request(method, url)
        .bearer_auth(&access.token)
        .header(PROOF_HEADER, proof(access, message))
        .send()
        .await
        .map_err(|_| Error::Network)
}

pub(super) async fn signed_call(
    client: &reqwest::Client,
    access: &Access,
    method: Method,
    path: &str,
    message: &[u8],
) -> Result<reqwest::Response, Error> {
    require_success(signed_request(client, access, method, path, message).await?)
}
