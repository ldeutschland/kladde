pub mod account;
mod closing_lists;
mod cursor;
pub mod engine;
mod socket;
pub mod watch;

pub use cursor::{Cursor, Writing};
pub use socket::Socket;

use futures_util::StreamExt;
use kladde_crypto as c;
use kladde_protocol::{
    self as p,
    compat::{self, OUTDATED_HEADER, Side},
};

use serde::{Serialize, de::DeserializeOwned};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Invalid sync server address")]
    Url,
    #[error("Authentication failed")]
    Auth,
    #[error("Sync connection failed")]
    Network,
    #[error("Invalid or conflicting sync history")]
    Conflict,
    #[error("Sync request refused")]
    Denied,
    #[error("Sync server busy")]
    Busy,
    #[error("Concurrent change, retry")]
    Stale,
    #[error("Local storage unavailable")]
    Storage,
    #[error("Sync server storage full")]
    Full,
    #[error("App or sync server must be updated")]
    Outdated(Side),
    #[error("Written by a newer app version")]
    Newer,
    #[error("A notebook key on the sync server is unreadable; repair it with the recovery phrase")]
    Unreadable,
    #[error("History from before a key change is not covered by a closing list")]
    Uncovered,
    #[error(transparent)]
    Crypto(#[from] c::Invalid),
    #[error(transparent)]
    Protocol(#[from] p::Invalid),
}

pub struct Origin(pub url::Url);

impl Origin {
    pub fn parse(value: &str) -> Result<Self, Error> {
        let address = url::Url::parse(value).map_err(|_| Error::Url)?;

        if (address.scheme() != "https" && !plaintext_loopback(&address))
            || address.host().is_none()
            || !address.username().is_empty()
            || address.password().is_some()
            || address.path() != "/"
            || address.query().is_some()
            || address.fragment().is_some()
        {
            return Err(Error::Url);
        }

        Ok(Self(address))
    }
}

#[cfg(feature = "loopback-test")]
fn plaintext_loopback(address: &url::Url) -> bool {
    address.scheme() == "http" && address.host_str() == Some("127.0.0.1")
}

#[cfg(not(feature = "loopback-test"))]
fn plaintext_loopback(_: &url::Url) -> bool {
    false
}

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

const REPLY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn outdated(side: Option<&str>) -> Error {
    match side.and_then(Side::parse) {
        Some(side) => Error::Outdated(side),
        None => Error::Denied,
    }
}

fn outdated_in(headers: &reqwest::header::HeaderMap) -> Error {
    outdated(headers.get(OUTDATED_HEADER).and_then(|v| v.to_str().ok()))
}

fn client_headers() -> Result<reqwest::header::HeaderMap, Error> {
    let mut headers = reqwest::header::HeaderMap::new();

    for (name, value) in compat::client_headers() {
        let value = reqwest::header::HeaderValue::from_str(&value).map_err(|_| Error::Network)?;

        headers.insert(reqwest::header::HeaderName::from_static(name), value);
    }

    Ok(headers)
}

pub fn http() -> Result<reqwest::Client, Error> {
    let builder = reqwest::Client::builder().default_headers(client_headers()?);

    #[cfg(feature = "native-acceptance")]
    let builder = builder.tls_built_in_root_certs(false).add_root_certificate(
        reqwest::Certificate::from_der(include_bytes!(env!("KLADDE_QA_CA")))
            .map_err(|_| Error::Network)?,
    );
    builder
        .https_only(!cfg!(feature = "loopback-test"))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REPLY_TIMEOUT)
        .build()
        .map_err(|_| Error::Network)
}

const REPLY_LIMIT: usize = 131072;

async fn post<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &Origin,
    path: &str,
    body: &impl Serialize,
) -> Result<T, Error> {
    post_limited(client, url, path, body, REPLY_LIMIT).await
}

async fn post_limited<T: DeserializeOwned>(
    client: &reqwest::Client,
    url: &Origin,
    path: &str,
    body: &impl Serialize,
    limit: usize,
) -> Result<T, Error> {
    let response = client
        .post(url.0.join(path).map_err(|_| Error::Url)?)
        .json(body)
        .send()
        .await
        .map_err(|_| Error::Network)?;
    let status = response.status();

    if status.is_server_error() {
        return Err(Error::Network);
    }

    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(Error::Busy);
    }

    if status == reqwest::StatusCode::UPGRADE_REQUIRED {
        return Err(outdated_in(response.headers()));
    }

    if status == reqwest::StatusCode::PRECONDITION_FAILED {
        return Err(Error::Stale);
    }

    if !status.is_success() {
        return Err(Error::Auth);
    }

    json_limited(response, limit).await
}

pub async fn json_limited<T: DeserializeOwned>(
    response: reqwest::Response,
    limit: usize,
) -> Result<T, Error> {
    let mut bytes = vec![];
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Error::Network)?;

        if bytes.len() + chunk.len() > limit {
            return Err(Error::Protocol(p::Invalid));
        }

        bytes.extend(chunk)
    }

    serde_json::from_slice(&bytes).map_err(|_| Error::Protocol(p::Invalid))
}
