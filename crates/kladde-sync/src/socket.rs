use crate::{CONNECT_TIMEOUT, Error, Origin, REPLY_TIMEOUT, account, outdated};
use futures_util::{SinkExt, StreamExt};
use kladde_protocol::{
    self as p, Client as Request, Server,
    compat::{self, OUTDATED_HEADER},
};

use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

pub(crate) enum Heard {
    Nothing,
    Alive,
    Message(Box<Server>),
}

pub(crate) type Stream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

type ClientRequest = tokio_tungstenite::tungstenite::handshake::client::Request;

type Handshake = Result<
    (
        Stream,
        tokio_tungstenite::tungstenite::handshake::client::Response,
    ),
    tokio_tungstenite::tungstenite::Error,
>;

fn sync_request(access: &account::Access) -> Result<(ClientRequest, url::Url), Error> {
    let mut url = Origin::parse(&access.origin)?.0;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };

    url.set_scheme(scheme).map_err(|_| Error::Url)?;
    url.set_path("v1/sync");
    let mut request = url.as_str().into_client_request().map_err(|_| Error::Url)?;

    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", access.token)
            .parse()
            .map_err(|_| Error::Auth)?,
    );

    for (name, value) in compat::client_headers() {
        let value = value.parse().map_err(|_| Error::Network)?;

        request.headers_mut().insert(name, value);
    }

    Ok((request, url))
}

fn socket_config() -> tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
    tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(p::MAX_WIRE))
        .max_frame_size(Some(p::MAX_WIRE))
}

#[cfg(not(feature = "native-acceptance"))]
async fn open_websocket(request: ClientRequest, _: &url::Url) -> Result<Handshake, Error> {
    tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(request, Some(socket_config()), false),
    )
    .await
    .map_err(|_| Error::Network)
}

#[cfg(feature = "native-acceptance")]
async fn open_websocket(request: ClientRequest, url: &url::Url) -> Result<Handshake, Error> {
    if url.host_str() != Some("127.0.0.1") {
        return Err(Error::Url);
    }

    let tls = acceptance_tls()?;

    tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_tls_with_config(
            request,
            Some(socket_config()),
            false,
            Some(tokio_tungstenite::Connector::Rustls(tls.into())),
        ),
    )
    .await
    .map_err(|_| Error::Network)
}

#[cfg(feature = "native-acceptance")]
fn acceptance_tls() -> Result<rustls::ClientConfig, Error> {
    let mut roots = rustls::RootCertStore::empty();

    roots
        .add(rustls::pki_types::CertificateDer::from(
            include_bytes!(env!("KLADDE_QA_CA")).as_slice(),
        ))
        .map_err(|_| Error::Network)?;

    Ok(
        rustls::ClientConfig::builder_with_provider(
            rustls::crypto::ring::default_provider().into(),
        )
        .with_safe_default_protocol_versions()
        .map_err(|_| Error::Network)?
        .with_root_certificates(roots)
        .with_no_client_auth(),
    )
}

fn handshake_error(error: tokio_tungstenite::tungstenite::Error) -> Error {
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 401 => {
            Error::Auth
        }
        tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 429 => {
            Error::Busy
        }
        tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 426 => {
            outdated(
                response
                    .headers()
                    .get(OUTDATED_HEADER)
                    .and_then(|value| value.to_str().ok()),
            )
        }
        _ => Error::Network,
    }
}

pub struct Socket(pub(crate) Stream);

impl Socket {
    pub async fn connect(access: &account::Access) -> Result<Self, Error> {
        let (request, url) = sync_request(access)?;
        let (socket, _) = open_websocket(request, &url)
            .await?
            .map_err(handshake_error)?;

        Ok(Self(socket))
    }

    pub async fn send(&mut self, message: &Request) -> Result<(), Error> {
        tokio::time::timeout(
            REPLY_TIMEOUT,
            self.0.send(Message::Binary(p::packet(message)?.into())),
        )
        .await
        .map_err(|_| Error::Network)?
        .map_err(|_| Error::Network)
    }

    pub(crate) async fn ping(&mut self) -> Result<(), Error> {
        tokio::time::timeout(REPLY_TIMEOUT, self.0.send(Message::Ping(Vec::new().into())))
            .await
            .map_err(|_| Error::Network)?
            .map_err(|_| Error::Network)
    }

    pub(crate) async fn listen(&mut self, wait: std::time::Duration) -> Result<Heard, Error> {
        let Ok(next) = tokio::time::timeout(wait, self.0.next()).await else {
            return Ok(Heard::Nothing);
        };

        match next.ok_or(Error::Network)?.map_err(|_| Error::Network)? {
            Message::Binary(b) => Ok(Heard::Message(Box::new(p::unpack(&b)?))),
            Message::Ping(_) | Message::Pong(_) => Ok(Heard::Alive),
            _ => Err(Error::Network),
        }
    }

    pub async fn receive(&mut self) -> Result<Server, Error> {
        loop {
            let msg = tokio::time::timeout(REPLY_TIMEOUT, self.0.next())
                .await
                .map_err(|_| Error::Network)?
                .ok_or(Error::Network)?
                .map_err(|_| Error::Network)?;
            match msg {
                Message::Binary(b) => return Ok(p::unpack(&b)?),
                Message::Ping(_) | Message::Pong(_) => continue,
                Message::Close(_) => return Err(Error::Network),
                _ => return Err(Error::Conflict),
            }
        }
    }
}
