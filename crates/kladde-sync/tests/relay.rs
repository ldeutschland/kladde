use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use kladde_crypto::{self as c};
use kladde_protocol::account::{
    NewSpace, PROOF_HEADER, erase_blob_message, purge_message, space_key_message,
};

use kladde_protocol::{self as p, Client, Server};
use kladde_sync::{
    Cursor, Error, Origin, Writing,
    account::{Access, Proof, login, new_space, prepare_rekey, register, rekey},
};

use std::collections::BTreeSet;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

use uuid::Uuid;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update, updates::decoder::Decode};

type Wire =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
async fn connect(base: &str, a: &Access) -> Wire {
    let mut r = base.replace("http:", "ws:").to_owned();

    r.push_str("v1/sync");
    let mut req = r.into_client_request().unwrap();

    req.headers_mut().insert(
        "authorization",
        format!("Bearer {}", a.token).parse().unwrap(),
    );

    connect_async(req).await.unwrap().0
}

async fn send(w: &mut Wire, req: &Client) {
    w.send(Message::Binary(p::packet(req).unwrap().into()))
        .await
        .unwrap()
}

async fn receive(w: &mut Wire) -> Server {
    let frame = w.next().await.unwrap().unwrap();

    p::unpack(&frame.into_data()).unwrap()
}

async fn pull(w: &mut Wire, a: &Access, c: &mut Cursor, id: Uuid, doc: &Doc) {
    send(
        w,
        &Client::Subscribe {
            space: a.space,
            doc: id,
            last_seq: c.seq,
            known_snapshot: c.snapshot,
        },
    )
    .await;

    loop {
        match receive(w).await {
            Server::Head { seq, .. } => {
                assert_eq!(seq, c.seq);
                break;
            }
            Server::Item {
                seq,
                envelope,
                certificate,
            } => {
                let plain = c.accept(a, id, seq, &envelope, &certificate).unwrap();

                doc.transact_mut()
                    .apply_update(Update::decode_v1(&plain).unwrap())
                    .unwrap();
                assert!(c.accept(a, id, seq, &envelope, &certificate).is_err())
            }
            _ => panic!("unexpected relay response"),
        }
    }
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn two_accounts_two_devices_offline_edits_and_recovery() {
    let base = std::env::var("KLADDE_TEST_RELAY").unwrap();
    let url = url::Url::parse(&base).unwrap();

    assert_eq!(url.host_str(), Some("127.0.0.1"));
    let origin = Origin(url);
    let http = reqwest::Client::new();
    let user = format!("test-{}", Uuid::new_v4());
    let password = "test-only-long-password";
    let space = Uuid::new_v4();
    let recovery = c::key();

    register(&http, &origin, &user, password, space, &recovery)
        .await
        .unwrap();
    assert!(
        login(&http, &origin, &user, "invalid-password-here", None)
            .await
            .is_err()
    );
    let a = login(&http, &origin, &user, password, None).await.unwrap();
    let b = login(&http, &origin, &user, password, None).await.unwrap();

    assert_eq!(a.workspace, b.workspace);
    assert_ne!(a.cert.device, b.cert.device);
    let mut wa = connect(&base, &a).await;
    let mut wb = connect(&base, &b).await;
    let doc_id = Uuid::new_v4();
    let da = Doc::new();
    let db = Doc::new();
    let mut ca = Cursor::default();
    let mut cb = Cursor::default();

    da.get_or_insert_text("t")
        .insert(&mut da.transact_mut(), 0, "KLADDE_PRIVATE_CANARY_84191");
    db.get_or_insert_text("t")
        .insert(&mut db.transact_mut(), 0, " zweite Notiz ");
    let req = ca
        .push(
            &a,
            doc_id,
            &da.transact()
                .encode_state_as_update_v1(&StateVector::default()),
        )
        .unwrap();
    send(&mut wa, &req).await;
    assert!(matches!(receive(&mut wa).await, Server::Ack { seq: 1, .. }));
    send(&mut wa, &req).await;
    assert!(matches!(receive(&mut wa).await, Server::Ack { seq: 1, .. }));
    pull(&mut wb, &b, &mut cb, doc_id, &db).await;
    let req = cb
        .push(
            &b,
            doc_id,
            &db.transact()
                .encode_state_as_update_v1(&StateVector::default()),
        )
        .unwrap();
    send(&mut wb, &req).await;
    assert!(matches!(receive(&mut wb).await, Server::Ack { seq: 2, .. }));
    pull(&mut wa, &a, &mut ca, doc_id, &da).await;
    pull(&mut wb, &b, &mut cb, doc_id, &db).await;
    let left = da.get_or_insert_text("t").get_string(&da.transact());
    let right = db.get_or_insert_text("t").get_string(&db.transact());

    assert_eq!(left, right);
    assert!(left.contains("KLADDE_PRIVATE_CANARY_84191"));
    assert!(left.contains("zweite Notiz"));
    let second = Uuid::new_v4();
    let stolen_token = new_space(&b, second).unwrap();

    assert!(!add_space(&http, &base, &a, &stolen_token).await);
    let added = new_space(&a, second).unwrap();
    let wrapped = added.wrapped.clone();

    assert!(add_space(&http, &base, &a, &added).await);
    let spaces: Vec<(Uuid, Option<Vec<u8>>)> = http
        .get(format!("{base}v1/workspaces"))
        .bearer_auth(&b.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        spaces
            .iter()
            .any(|(id, key)| *id == second && key.as_ref() == Some(&wrapped))
    );
    let file_id = Uuid::new_v4();
    let blob_url = format!("{base}v1/spaces/{space}/blobs/{file_id}");
    let file_key = c::key();
    let blob =
        p::encode(&c::files::encrypt(&file_key, b"KLADDE_PRIVATE_FILE_CANARY").unwrap()).unwrap();
    assert!(
        http.put(&blob_url)
            .bearer_auth(&a.token)
            .body(blob.clone())
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    let downloaded = http
        .get(&blob_url)
        .bearer_auth(&b.token)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(downloaded.as_ref(), blob);
    assert_eq!(
        c::files::decrypt(&file_key, &p::decode(&downloaded).unwrap())
            .unwrap()
            .as_slice(),
        b"KLADDE_PRIVATE_FILE_CANARY"
    );
    let other = format!("other-{}", Uuid::new_v4());

    register(&http, &origin, &other, password, Uuid::new_v4(), &c::key())
        .await
        .unwrap();
    let stranger = login(&http, &origin, &other, password, None).await.unwrap();
    let denied = http
        .get(format!("{base}v1/spaces/{space}/docs"))
        .bearer_auth(&stranger.token)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 401);
    assert_eq!(
        erase_blob(&http, &blob_url, &stranger, space, file_id).await,
        401
    );

    for _ in 0..2 {
        assert_eq!(erase_blob(&http, &blob_url, &a, space, file_id).await, 204);
    }

    assert!(
        !http
            .get(&blob_url)
            .bearer_auth(&a.token)
            .send()
            .await
            .unwrap()
            .status()
            .is_success()
    );
    let devices_before: Vec<Uuid> = http
        .get(format!("{base}v1/devices"))
        .bearer_auth(&a.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(devices_before.len(), 2);
    assert_eq!(
        http.delete(format!("{base}v1/devices/{}", b.cert.device))
            .bearer_auth(&a.token)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    let removal_phrase = c::key();

    rekey(
        &http,
        &origin,
        &user,
        Proof::Password(password),
        password,
        &removal_phrase,
    )
    .await
    .unwrap();

    for old in [&a, &b] {
        assert!(
            !http
                .get(format!("{base}v1/devices"))
                .bearer_auth(&old.token)
                .send()
                .await
                .unwrap()
                .status()
                .is_success()
        );
    }

    let renewed = login(&http, &origin, &user, password, Some(&a))
        .await
        .unwrap();
    assert_eq!(renewed.epoch(), 2);
    assert!(renewed.workspace.starts_with(&a.workspace));
    assert_ne!(renewed.identity, a.identity);
    assert_ne!(renewed.master, a.master);
    assert_ne!(renewed.cert.device, a.cert.device);
    let renewed_spaces: Vec<(Uuid, Option<Vec<u8>>)> = http
        .get(format!("{base}v1/workspaces"))
        .bearer_auth(&renewed.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let second_blob = renewed_spaces
        .iter()
        .find(|(id, _)| *id == second)
        .and_then(|(_, key)| key.clone())
        .unwrap();
    let second_keys = c::unwrap(
        &renewed.master,
        second,
        c::Purpose::Workspace,
        &p::decode(&second_blob).unwrap(),
    )
    .unwrap();

    assert_eq!(second_keys.len(), 128);
    let mut wr = connect(&base, &renewed).await;
    let mut cr = ca.clone();
    let dr = Doc::new();

    pull(&mut wr, &renewed, &mut cr, doc_id, &dr).await;
    assert!(cr.needs_rekey_snapshot(&renewed));
    let req = cr
        .push(
            &renewed,
            doc_id,
            &da.transact()
                .encode_state_as_update_v1(&StateVector::default()),
        )
        .unwrap();
    send(&mut wr, &req).await;
    assert!(matches!(receive(&mut wr).await, Server::Ack { seq: 3, .. }));
    let mut fresh = Cursor::default();
    let df = Doc::new();

    pull(&mut wr, &renewed, &mut fresh, doc_id, &df).await;
    assert_eq!(fresh.epoch, 2);
    let mut forging = ca.clone();

    forging.snapshot = None;
    let stale = forging
        .push(
            &a,
            doc_id,
            &da.transact()
                .encode_state_as_update_v1(&StateVector::default()),
        )
        .unwrap();
    let Client::PushSnapshot { envelope, .. } = stale else {
        panic!("expected snapshot")
    };

    assert!(
        fresh
            .clone()
            .accept(&renewed, doc_id, 4, &envelope, &a.cert)
            .is_err()
    );
    let lost_phrase = c::recovery(&recovery).unwrap();

    assert!(
        rekey(
            &http,
            &origin,
            &user,
            Proof::Recovery(&lost_phrase),
            "new-test-password-987",
            &c::key(),
        )
        .await
        .is_err()
    );
    let recovered_phrase = c::key();

    rekey(
        &http,
        &origin,
        &user,
        Proof::Recovery(&c::recovery(&removal_phrase).unwrap()),
        "new-test-password-987",
        &recovered_phrase,
    )
    .await
    .unwrap();
    assert!(login(&http, &origin, &user, password, None).await.is_err());
    let reset = login(
        &http,
        &origin,
        &user,
        "new-test-password-987",
        Some(&renewed),
    )
    .await
    .unwrap();

    assert_eq!(reset.epoch(), 3);
    assert!(reset.workspace.starts_with(&a.workspace));
    assert!(
        rekey(
            &http,
            &origin,
            &user,
            Proof::Password(password),
            "final-change-123456",
            &c::key(),
        )
        .await
        .is_err()
    );
    rekey(
        &http,
        &origin,
        &user,
        Proof::Password("new-test-password-987"),
        "final-change-123456",
        &c::key(),
    )
    .await
    .unwrap();
    assert!(
        login(&http, &origin, &user, "new-test-password-987", None)
            .await
            .is_err()
    );
    let changed = login(&http, &origin, &user, "final-change-123456", Some(&reset))
        .await
        .unwrap();
    assert_eq!(changed.epoch(), 4);
    assert!(changed.workspace.starts_with(&a.workspace));
    assert!(
        login(&http, &origin, &user, "final-change-123456", Some(&a))
            .await
            .is_ok()
    );
}

async fn put_blob(http: &reqwest::Client, base: &str, a: &Access, id: Uuid, body: &[u8]) -> u16 {
    http.put(format!("{base}v1/spaces/{}/blobs/{id}", a.space))
        .bearer_auth(&a.token)
        .body(body.to_vec())
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

async fn listed_blobs(
    http: &reqwest::Client,
    base: &str,
    a: &Access,
) -> Result<BTreeSet<Uuid>, u16> {
    let r = http
        .get(format!("{base}v1/spaces/{}/blobs", a.space))
        .bearer_auth(&a.token)
        .send()
        .await
        .unwrap();
    match r.status().as_u16() {
        200 => Ok(r.json().await.unwrap()),
        status => Err(status),
    }
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn the_relay_lists_only_stored_blobs_and_takes_a_lost_one_again() {
    let base = std::env::var("KLADDE_TEST_RELAY").unwrap();
    let blob_dir = std::path::PathBuf::from(std::env::var("BLOB_DIR").unwrap());
    let origin = Origin(url::Url::parse(&base).unwrap());
    let http = reqwest::Client::new();
    let password = "test-only-long-password";
    let user = format!("test-{}", Uuid::new_v4());

    register(&http, &origin, &user, password, Uuid::new_v4(), &c::key())
        .await
        .unwrap();
    let a = login(&http, &origin, &user, password, None).await.unwrap();
    let kept = Uuid::new_v4();
    let lost = Uuid::new_v4();
    let blob = p::encode(&c::files::encrypt(&c::key(), b"blob list probe").unwrap()).unwrap();

    assert_eq!(put_blob(&http, &base, &a, kept, &blob).await, 201);
    assert_eq!(put_blob(&http, &base, &a, lost, &blob).await, 201);
    std::fs::remove_file(blob_dir.join(a.account.to_string()).join(lost.to_string())).unwrap();
    assert_eq!(
        listed_blobs(&http, &base, &a).await,
        Ok(BTreeSet::from([kept]))
    );
    assert_eq!(put_blob(&http, &base, &a, lost, &blob).await, 201);
    assert_eq!(put_blob(&http, &base, &a, kept, &blob).await, 409);
    assert_eq!(
        listed_blobs(&http, &base, &a).await,
        Ok(BTreeSet::from([kept, lost]))
    );
    let other = format!("other-{}", Uuid::new_v4());

    register(&http, &origin, &other, password, Uuid::new_v4(), &c::key())
        .await
        .unwrap();
    let mut foreign = login(&http, &origin, &other, password, None).await.unwrap();

    foreign.space = a.space;
    assert_eq!(listed_blobs(&http, &base, &foreign).await, Err(401));
}

async fn add_space(http: &reqwest::Client, base: &str, a: &Access, space: &NewSpace) -> bool {
    http.post(format!("{base}v1/workspaces"))
        .bearer_auth(&a.token)
        .json(space)
        .send()
        .await
        .unwrap()
        .status()
        .is_success()
}

async fn space_ids(http: &reqwest::Client, base: &str, a: &Access) -> Vec<Uuid> {
    let spaces: Vec<(Uuid, Option<Vec<u8>>)> = http
        .get(format!("{base}v1/workspaces"))
        .bearer_auth(&a.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    spaces.into_iter().map(|(id, _)| id).collect()
}

async fn fresh_account(http: &reqwest::Client) -> (String, Origin, String, c::Key) {
    let base = std::env::var("KLADDE_TEST_RELAY").unwrap();
    let origin = Origin(url::Url::parse(&base).unwrap());
    let user = format!("test-{}", Uuid::new_v4());
    let recovery = c::key();

    register(http, &origin, &user, PASSWORD, Uuid::new_v4(), &recovery)
        .await
        .unwrap();
    (base, origin, user, recovery)
}

const PASSWORD: &str = "test-only-long-password";

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_key_change_the_relay_never_stored_is_not_confirmed() {
    let http = reqwest::Client::new();
    let (_, origin, user, _) = fresh_account(&http).await;
    let before = login(&http, &origin, &user, PASSWORD, None).await.unwrap();
    let password = Proof::Password(PASSWORD);
    let dropped = prepare_rekey(&http, &origin, &user, password, PASSWORD, &c::key())
        .await
        .unwrap();
    let unchanged = login(&http, &origin, &user, PASSWORD, Some(&before))
        .await
        .unwrap();
    assert!(!dropped.expected.confirmed_by(&unchanged));
    let password = Proof::Password(PASSWORD);
    let stored = prepare_rekey(&http, &origin, &user, password, PASSWORD, &c::key())
        .await
        .unwrap();
    let expected = stored.send(&http, &origin).await.unwrap();
    let rotated = login(&http, &origin, &user, PASSWORD, Some(&unchanged))
        .await
        .unwrap();
    assert!(expected.confirmed_by(&rotated));
    assert!(!dropped.expected.confirmed_by(&rotated));
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn the_recovery_phrase_repairs_an_unreadable_notebook_key() {
    let http = reqwest::Client::new();
    let (base, origin, user, recovery) = fresh_account(&http).await;
    let a = login(&http, &origin, &user, PASSWORD, None).await.unwrap();
    let kept = Uuid::new_v4();

    assert!(add_space(&http, &base, &a, &new_space(&a, kept).unwrap()).await);
    let damaged = Uuid::new_v4();
    let garbage = vec![7; 96];
    let device = SigningKey::from_bytes(&a.device_key);
    let proof = device.sign(&space_key_message(a.account, damaged, &garbage).unwrap());
    let unreadable = NewSpace {
        space: damaged,
        wrapped: garbage,
        proof: proof.to_bytes().to_vec(),
    };

    assert!(add_space(&http, &base, &a, &unreadable).await);
    let blob = |space: Uuid, id: Uuid| format!("{base}v1/spaces/{space}/blobs/{id}");
    let (kept_file, damaged_file) = (Uuid::new_v4(), Uuid::new_v4());

    for (space, file) in [(kept, kept_file), (damaged, damaged_file)] {
        let put = http.put(blob(space, file)).bearer_auth(&a.token);
        let sent = put.body(vec![9; 64]).send().await.unwrap();

        assert!(sent.status().is_success());
    }

    let password = Proof::Password(PASSWORD);
    let blocked = rekey(&http, &origin, &user, password, PASSWORD, &c::key()).await;

    assert!(matches!(blocked, Err(Error::Unreadable)));
    let phrase = c::recovery(&recovery).unwrap();
    let repaired = Proof::Recovery(&phrase);

    rekey(&http, &origin, &user, repaired, PASSWORD, &c::key())
        .await
        .unwrap();
    let after = login(&http, &origin, &user, PASSWORD, Some(&a))
        .await
        .unwrap();
    let remaining = space_ids(&http, &base, &after).await;

    assert!(remaining.contains(&kept) && remaining.contains(&after.space));
    assert!(!remaining.contains(&damaged));
    let read = |space, file| http.get(blob(space, file)).bearer_auth(&after.token).send();
    let kept_read = read(kept, kept_file).await.unwrap();

    assert!(kept_read.status().is_success());
    assert_eq!(kept_read.bytes().await.unwrap().as_ref(), &[9; 64]);
    assert!(
        !read(damaged, damaged_file)
            .await
            .unwrap()
            .status()
            .is_success()
    );
}

fn blob_url(base: &str, a: &Access, id: Uuid) -> String {
    format!("{base}v1/spaces/{}/blobs/{id}", a.space)
}

type HeldUpload = (
    tokio::sync::mpsc::Sender<Vec<u8>>,
    tokio::task::JoinHandle<u16>,
);

fn put_held(http: &reqwest::Client, url: String, a: &Access, declared: usize) -> HeldUpload {
    let (sender, receiver) = tokio::sync::mpsc::channel::<Vec<u8>>(4);
    let chunks = futures_util::stream::unfold(receiver, |mut receiver| async move {
        let chunk = receiver.recv().await?;

        Some((Ok::<_, std::io::Error>(chunk), receiver))
    });
    let request = http
        .put(url)
        .bearer_auth(&a.token)
        .header(reqwest::header::CONTENT_LENGTH, declared)
        .body(reqwest::Body::wrap_stream(chunks));
    let task = tokio::spawn(async move {
        request
            .send()
            .await
            .map_or(0, |response| response.status().as_u16())
    });

    (sender, task)
}

async fn finished(task: tokio::task::JoinHandle<u16>) -> u16 {
    tokio::time::timeout(std::time::Duration::from_secs(10), task)
        .await
        .expect("the relay answers without waiting for the body")
        .unwrap()
}

fn unfinished_uploads(a: &Access) -> usize {
    let blob_dir = std::path::PathBuf::from(std::env::var("BLOB_DIR").unwrap());

    std::fs::read_dir(blob_dir.join(a.account.to_string()))
        .map(|entries| {
            entries
                .filter(|e| {
                    e.as_ref()
                        .is_ok_and(|e| e.file_name().to_string_lossy().ends_with(".writing"))
                })
                .count()
        })
        .unwrap_or(0)
}

async fn logged_in(http: &reqwest::Client, base: &str) -> Access {
    let origin = Origin(url::Url::parse(base).unwrap());
    let user = format!("test-{}", Uuid::new_v4());

    register(http, &origin, &user, PASSWORD, Uuid::new_v4(), &c::key())
        .await
        .unwrap();
    login(http, &origin, &user, PASSWORD, None).await.unwrap()
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn the_relay_checks_length_and_quota_before_reading_an_upload() {
    let base = std::env::var("KLADDE_TEST_RELAY").unwrap();
    let http = reqwest::Client::new();
    let a = logged_in(&http, &base).await;
    let unsized_body = futures_util::stream::iter([Ok::<_, std::io::Error>(vec![0u8; 32])]);
    let unsized_status = http
        .put(blob_url(&base, &a, Uuid::new_v4()))
        .bearer_auth(&a.token)
        .body(reqwest::Body::wrap_stream(unsized_body))
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(unsized_status, 411);
    let (_over_quota, over_quota) = put_held(
        &http,
        blob_url(&base, &a, Uuid::new_v4()),
        &a,
        9 * 1024 * 1024,
    );

    assert_eq!(finished(over_quota).await, 507);
    let too_large = p::MAX_ENCODED_ATTACHMENT + 1;
    let (_oversized, oversized) =
        put_held(&http, blob_url(&base, &a, Uuid::new_v4()), &a, too_large);
    assert_eq!(finished(oversized).await, 413);
    assert_eq!(
        put_blob(&http, &base, &a, Uuid::new_v4(), &[1u8; 15]).await,
        400
    );
    assert_eq!(unfinished_uploads(&a), 0);
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn the_relay_limits_parallel_uploads_and_streams_downloads() {
    let base = std::env::var("KLADDE_TEST_RELAY").unwrap();
    let http = reqwest::Client::new();
    let a = logged_in(&http, &base).await;
    let blob = vec![9u8; 32];
    let (first_id, second_id) = (Uuid::new_v4(), Uuid::new_v4());
    let (first_body, first) = put_held(&http, blob_url(&base, &a, first_id), &a, blob.len());
    let (second_body, second) = put_held(&http, blob_url(&base, &a, second_id), &a, blob.len());

    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    assert_eq!(unfinished_uploads(&a), 2);
    assert_eq!(put_blob(&http, &base, &a, Uuid::new_v4(), &blob).await, 429);
    first_body.send(blob.clone()).await.unwrap();
    drop(first_body);
    assert_eq!(finished(first).await, 201);
    drop(second_body);
    assert_ne!(finished(second).await, 201);

    for _ in 0..20 {
        if unfinished_uploads(&a) == 0 {
            break;
        }

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    assert_eq!(unfinished_uploads(&a), 0);
    assert_eq!(put_blob(&http, &base, &a, second_id, &blob).await, 201);
    let downloaded = http
        .get(blob_url(&base, &a, first_id))
        .bearer_auth(&a.token)
        .send()
        .await
        .unwrap();
    assert_eq!(downloaded.status(), 200);
    assert_eq!(downloaded.content_length(), Some(blob.len() as u64));
    assert_eq!(downloaded.bytes().await.unwrap().as_ref(), blob.as_slice());
}

fn proof(a: &Access, message: &[u8]) -> String {
    SigningKey::from_bytes(&a.device_key)
        .sign(message)
        .to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn current_headers() -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();

    for (name, value) in p::compat::client_headers() {
        headers.insert(
            reqwest::header::HeaderName::from_static(name),
            value.parse().unwrap(),
        );
    }

    headers
}

async fn erase_blob(http: &reqwest::Client, url: &str, a: &Access, space: Uuid, id: Uuid) -> u16 {
    let message = erase_blob_message(a.account, space, id).unwrap();

    http.delete(url)
        .bearer_auth(&a.token)
        .headers(current_headers())
        .header(PROOF_HEADER, proof(a, &message))
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

async fn status_of(request: reqwest::RequestBuilder) -> u16 {
    request.send().await.unwrap().status().as_u16()
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn registration_and_login_share_the_password_budget_of_a_known_name() {
    let base = std::env::var("KLADDE_TEST_RELAY").unwrap();
    let http = reqwest::Client::new();
    let origin = Origin(url::Url::parse(&base).unwrap());
    let user = format!("budget-{}", Uuid::new_v4());
    let unknown = format!("nobody-{}", Uuid::new_v4());
    let start = |path: &str, name: &str| {
        http.post(format!("{base}{path}"))
            .json(&serde_json::json!({ "user": name, "message": [] }))
    };

    register(&http, &origin, &user, PASSWORD, Uuid::new_v4(), &c::key())
        .await
        .unwrap();

    for _ in 0..10 {
        assert_eq!(status_of(start("v1/register/start", &user)).await, 400);
    }

    assert_eq!(status_of(start("v1/register/start", &user)).await, 429);
    assert_eq!(status_of(start("v1/login/start", &user)).await, 429);

    for _ in 0..11 {
        assert_eq!(status_of(start("v1/register/start", &unknown)).await, 400);
    }
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn the_relay_refuses_a_push_its_device_did_not_sign() {
    let base = std::env::var("KLADDE_TEST_RELAY").unwrap();
    let a = logged_in(&reqwest::Client::new(), &base).await;
    let writing = Writing {
        checkpoints: false,
        format: p::compat::LEGACY_FORMAT,
    };

    let Client::PushSnapshot {
        mut envelope,
        parent,
        covers,
    } = Cursor::default()
        .push_as(&a, Uuid::new_v4(), b"echt", writing)
        .unwrap()
    else {
        panic!("a first push is a snapshot");
    };

    envelope.signature[0] ^= 1;
    let mut forged = connect(&base, &a).await;

    send(
        &mut forged,
        &Client::PushSnapshot {
            envelope,
            parent,
            covers,
        },
    )
    .await;
    assert!(!matches!(forged.next().await, Some(Ok(Message::Binary(_)))));

    let honest = Cursor::default()
        .push_as(&a, Uuid::new_v4(), b"echt", writing)
        .unwrap();
    let mut wire = connect(&base, &a).await;

    send(&mut wire, &honest).await;
    assert!(matches!(
        receive(&mut wire).await,
        Server::Ack { seq: 1, .. }
    ));
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn destructive_requests_need_a_proof_from_the_signed_in_device() {
    let base = std::env::var("KLADDE_TEST_RELAY").unwrap();
    let http = reqwest::Client::new();
    let a = logged_in(&http, &base).await;
    let id = Uuid::new_v4();
    let blob = p::encode(&c::files::encrypt(&c::key(), b"weg damit").unwrap()).unwrap();
    let url = format!("{base}v1/spaces/{}/blobs/{id}", a.space);
    let unrelated = erase_blob_message(a.account, a.space, Uuid::new_v4()).unwrap();

    assert_eq!(put_blob(&http, &base, &a, id, &blob).await, 201);
    assert_eq!(
        status_of(http.delete(&url).bearer_auth(&a.token)).await,
        426
    );
    assert_eq!(
        status_of(
            http.delete(&url)
                .bearer_auth(&a.token)
                .headers(current_headers())
        )
        .await,
        401
    );
    assert_eq!(
        status_of(
            http.delete(&url)
                .bearer_auth(&a.token)
                .headers(current_headers())
                .header(PROOF_HEADER, proof(&a, &unrelated))
        )
        .await,
        401
    );
    assert_eq!(erase_blob(&http, &url, &a, a.space, id).await, 204);

    let doc = Uuid::new_v4();
    let purge = format!("{base}v1/spaces/{}/docs/{doc}", a.space);
    let signed = purge_message(a.account, a.space, doc).unwrap();
    let unsigned = http
        .delete(&purge)
        .bearer_auth(&a.token)
        .headers(current_headers());

    assert_eq!(status_of(unsigned).await, 401);
    assert_eq!(
        status_of(
            http.delete(&purge)
                .bearer_auth(&a.token)
                .headers(current_headers())
                .header(PROOF_HEADER, proof(&a, &signed))
        )
        .await,
        204
    );
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_signed_out_session_closes_its_socket_at_the_next_ping() {
    let base = std::env::var("KLADDE_TEST_RELAY").unwrap();
    let http = reqwest::Client::new();
    let a = logged_in(&http, &base).await;
    let mut wire = connect(&base, &a).await;
    let signed_out = http
        .delete(format!("{base}v1/session"))
        .bearer_auth(&a.token);

    assert!(status_of(signed_out).await < 300);
    wire.send(Message::Ping(vec![1].into())).await.unwrap();
    let closed = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while let Some(Ok(frame)) = wire.next().await {
            if frame.is_close() {
                break;
            }
        }
    })
    .await;

    assert!(closed.is_ok());
}
