use futures_util::{SinkExt, StreamExt};
use kladde_crypto as c;
use kladde_protocol::{
    self as p, Client, Server,
    compat::{self, Hello, OUTDATED_HEADER},
};

use kladde_sync::{
    Cursor, Error, Origin, Writing,
    account::{Access, login, register},
};

use std::collections::BTreeMap;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{self, Message, client::IntoClientRequest},
};

use uuid::Uuid;

type Wire =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const PASSWORD: &str = "test-only-long-password";
const CURRENT: [(&str, &str); 3] = [
    ("kladde-protocol", "1-1"),
    ("kladde-features", "checkpoints,full,outdated"),
    ("kladde-format", "1"),
];
const FUTURE_FORMAT: u8 = compat::FORMAT + 1;

fn base() -> String {
    std::env::var("KLADDE_TEST_RELAY").unwrap()
}

async fn account() -> (Origin, String) {
    let origin = Origin(url::Url::parse(&base()).unwrap());
    let user = format!("compat-{}", Uuid::new_v4());
    let http = reqwest::Client::new();

    register(&http, &origin, &user, PASSWORD, Uuid::new_v4(), &c::key())
        .await
        .unwrap();
    (origin, user)
}

async fn device(origin: &Origin, user: &str) -> Access {
    let http = reqwest::Client::new();

    login(&http, origin, user, PASSWORD, None).await.unwrap()
}

async fn connect(a: &Access, headers: &[(&'static str, &str)]) -> Result<Wire, tungstenite::Error> {
    let url = format!("{}v1/sync", base().replace("http:", "ws:"));
    let mut request = url.into_client_request().unwrap();
    let fields = request.headers_mut();

    fields.insert(
        "authorization",
        format!("Bearer {}", a.token).parse().unwrap(),
    );

    for (name, value) in headers {
        fields.insert(*name, value.parse().unwrap());
    }

    Ok(connect_async(request).await?.0)
}

async fn send(w: &mut Wire, request: &Client) {
    w.send(Message::Binary(p::packet(request).unwrap().into()))
        .await
        .unwrap()
}

async fn receive(w: &mut Wire) -> Option<Server> {
    loop {
        match w.next().await? {
            Ok(Message::Binary(b)) => return Some(p::unpack(&b).unwrap()),
            Ok(Message::Ping(_) | Message::Pong(_)) => continue,
            _ => return None,
        }
    }
}

fn subscribe(a: &Access, doc: Uuid) -> Client {
    Client::Subscribe {
        space: a.space,
        doc,
        last_seq: 0,
        known_snapshot: None,
    }
}

async fn push_future_snapshot(a: &Access, doc: Uuid) {
    let writing = Writing {
        checkpoints: false,
        format: FUTURE_FORMAT,
    };

    let request = Cursor::default()
        .push_as(a, doc, b"from a later app", writing)
        .unwrap();
    let headers = future_headers();
    let mut wire = connect(a, &borrowed(&headers)).await.unwrap();

    send(&mut wire, &request).await;
    assert!(matches!(
        receive(&mut wire).await,
        Some(Server::Ack { seq: 1, .. })
    ));
}

fn future_headers() -> [(&'static str, String); 3] {
    [
        ("kladde-protocol", "1-1".into()),
        ("kladde-features", "checkpoints,full,outdated".into()),
        ("kladde-format", FUTURE_FORMAT.to_string()),
    ]
}

fn borrowed<'a>(headers: &'a [(&'static str, String); 3]) -> Vec<(&'static str, &'a str)> {
    headers.iter().map(|(n, v)| (*n, v.as_str())).collect()
}

async fn status_with(path: &str, headers: &[(&str, &str)]) -> reqwest::Response {
    let mut request = reqwest::Client::new().get(format!("{}{path}", base()));

    for (name, value) in headers {
        request = request.header(*name, *value);
    }

    request.send().await.unwrap()
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn the_relay_introduces_itself_without_a_session() {
    let response = status_with("v1/hello", &[("kladde-protocol", "200-201")]).await;

    assert_eq!(response.status(), 200);
    let hello: Hello = response.json().await.unwrap();
    let offered = hello.offered().unwrap();

    assert_eq!(offered, compat::RELAY_FEATURES.into_iter().collect());
    assert!(!hello.behind());
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn outdated_clients_learn_which_side_must_update() {
    let cases = [
        (("kladde-protocol", "200-201"), "server"),
        (("kladde-features", "full,outdated"), "app"),
    ];

    for (header, side) in cases {
        let response = status_with("v1/workspaces", &[header]).await;

        assert_eq!(response.status(), 426);
        let named = response.headers().get(OUTDATED_HEADER).unwrap();

        assert_eq!(named.to_str().unwrap(), side);
        let hello: Hello = response.json().await.unwrap();

        assert_eq!(hello.protocol, compat::PROTOCOL);
    }

    for header in [("kladde-protocol", "x"), ("kladde-format", "0")] {
        assert_eq!(status_with("v1/workspaces", &[header]).await.status(), 400);
    }

    let twice = [("kladde-format", "1"), ("kladde-format", "1")];

    assert_eq!(status_with("v1/workspaces", &twice).await.status(), 400);
    assert_eq!(status_with("v1/workspaces", &CURRENT).await.status(), 401);
    assert_eq!(status_with("v1/workspaces", &[]).await.status(), 401);
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn the_sync_socket_refuses_outdated_clients_by_name() {
    let (origin, user) = account().await;
    let a = device(&origin, &user).await;
    let refused = connect(&a, &[("kladde-protocol", "200-201")]).await;
    let Err(tungstenite::Error::Http(response)) = refused else {
        panic!("an outdated client was accepted");
    };

    assert_eq!(response.status(), 426);
    let named = response.headers().get(OUTDATED_HEADER).unwrap();

    assert_eq!(named.to_str().unwrap(), "server");
    assert!(connect(&a, &CURRENT).await.is_ok());
    assert!(connect(&a, &[]).await.is_ok());
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn readers_of_older_formats_are_told_instead_of_fed() {
    let (origin, user) = account().await;
    let future = device(&origin, &user).await;
    let current = device(&origin, &user).await;
    let legacy = device(&origin, &user).await;
    let doc = Uuid::new_v4();

    push_future_snapshot(&future, doc).await;

    let mut wire = connect(&current, &CURRENT).await.unwrap();

    send(&mut wire, &subscribe(&current, doc)).await;
    assert!(matches!(receive(&mut wire).await, Some(Server::Outdated { doc: d }) if d == doc));
    let empty = Uuid::new_v4();

    send(&mut wire, &subscribe(&current, empty)).await;
    assert!(matches!(
        receive(&mut wire).await,
        Some(Server::Head { seq: 0, .. })
    ));

    let mut old = connect(&legacy, &[]).await.unwrap();

    send(&mut old, &subscribe(&legacy, doc)).await;
    assert!(receive(&mut old).await.is_none());

    let headers = future_headers();
    let mut reader = connect(&current, &borrowed(&headers)).await.unwrap();

    send(&mut reader, &subscribe(&current, doc)).await;
    let Some(Server::Item {
        seq,
        envelope,
        certificate,
    }) = receive(&mut reader).await
    else {
        panic!("a reader of the newer format got no item");
    };

    let opened = Cursor::default().accept(&current, doc, seq, &envelope, &certificate);

    assert!(matches!(opened, Err(Error::Newer)));
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn the_relay_remembers_which_format_each_device_reads() {
    let (origin, user) = account().await;
    let future = device(&origin, &user).await;
    let current = device(&origin, &user).await;
    let headers = future_headers();

    drop(connect(&future, &borrowed(&headers)).await.unwrap());
    drop(connect(&current, &[]).await.unwrap());
    let formats: BTreeMap<Uuid, u8> = reqwest::Client::new()
        .get(format!("{}v1/devices/formats", base()))
        .bearer_auth(&current.token)
        .send()
        .await
        .unwrap()
        .json::<Vec<(Uuid, u8)>>()
        .await
        .unwrap()
        .into_iter()
        .collect();
    assert_eq!(formats.get(&future.cert.device), Some(&FUTURE_FORMAT));
    assert_eq!(
        formats.get(&current.cert.device),
        Some(&compat::LEGACY_FORMAT)
    );
}
