#![cfg(feature = "loopback-test")]
use kladde_crypto as c;
use kladde_store::{Note, Store};
use kladde_sync::{
    Error, Origin,
    account::{Access, Proof, login, prepare_rekey, register, rekey},
    engine::{self, Local, Report},
};

use std::{collections::BTreeSet, sync::Mutex};
use uuid::Uuid;
use yrs::{Doc, GetString, Map, ReadTxn, StateVector, Text, Transact, Update};

struct Device {
    store: Mutex<Store>,
    access: Access,
    edit_on_listing: Mutex<Option<(Uuid, &'static str)>>,
    _dir: tempfile::TempDir,
}

impl Local for Device {
    fn with<T>(
        &self,
        work: impl FnOnce(&mut Store) -> Result<T, kladde_store::Error>,
    ) -> Result<T, Error> {
        work(&mut self.store.lock().unwrap()).map_err(engine::local_error)
    }

    fn changed(&self, id: Uuid) {
        if id != self.access.space {
            return;
        }

        let edit = self.edit_on_listing.lock().unwrap().take();

        if let Some((page, text)) = edit {
            write_text(self, page, text);
        }
    }
}

fn open_store() -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("notebook.db"), &[9; 32]).unwrap();

    (store, dir)
}

async fn signed_in(origin: &Origin, user: &str) -> Access {
    let http = kladde_sync::http().unwrap();

    login(&http, origin, user, PASSWORD, None).await.unwrap()
}

async fn device(origin: &Origin, user: &str) -> Device {
    let access = signed_in(origin, user).await;
    let (store, dir) = open_store();

    Device {
        store: Mutex::new(store),
        access,
        edit_on_listing: Mutex::new(None),
        _dir: dir,
    }
}

const PASSWORD: &str = "test-only-long-password";

fn state_of(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn load_doc(device: &Device, id: Uuid) -> (Doc, i64) {
    let note = device.with(|s| s.get(id)).unwrap().unwrap();
    let doc = Doc::new();

    doc.transact_mut()
        .apply_update(Update::decode_complete_v1(&note.data).unwrap())
        .unwrap();
    (doc, note.rev)
}

fn note(space: Uuid, id: Uuid, kind: &str, doc: &Doc, rev: i64) -> Note {
    Note {
        id,
        space,
        kind: kind.into(),
        title: String::new(),
        body: String::new(),
        parent: None,
        archived: false,
        props: "{}".into(),
        links: Vec::new(),
        data: state_of(doc),
        rev,
    }
}

fn save(device: &Device, n: Note) {
    device.with(|s| s.save(&[n], false)).unwrap();
}

fn write_text(device: &Device, id: Uuid, text: &str) {
    let space = device.access.space;
    let existing = device.with(|s| s.get(id)).unwrap();
    let (doc, rev) = match existing {
        Some(_) => load_doc(device, id),
        None => (Doc::new(), 0),
    };

    let body = doc.get_or_insert_text("body");
    let end = body.len(&doc.transact());

    body.insert(&mut doc.transact_mut(), end, text);
    save(device, note(space, id, "page", &doc, rev));
}

fn read_text(device: &Device, id: Uuid) -> String {
    let (doc, _) = load_doc(device, id);
    let text = doc.get_or_insert_text("body");

    text.get_string(&doc.transact())
}

fn list_pages(device: &Device, add: &[Uuid], remove: &[Uuid]) {
    let space = device.access.space;
    let existing = device.with(|s| s.get(space)).unwrap();
    let (doc, rev) = match existing {
        Some(_) => load_doc(device, space),
        None => (Doc::new(), 0),
    };

    let pages = doc.get_or_insert_map("pages");
    let mut txn = doc.transact_mut();

    for id in add {
        pages.insert(&mut txn, id.to_string(), "page");
    }

    for id in remove {
        pages.remove(&mut txn, &id.to_string());
    }

    drop(txn);
    save(device, note(space, space, "workspace", &doc, rev));
}

fn list_in_directory(device: &Device, shard: Uuid, add: &[Uuid], remove: &[Uuid]) {
    let space = device.access.space;
    let existing = device.with(|s| s.get(shard)).unwrap();
    let (doc, rev) = match existing {
        Some(_) => load_doc(device, shard),
        None => (Doc::new(), 0),
    };

    let pages = doc.get_or_insert_map("pages");
    let mut txn = doc.transact_mut();

    for id in add {
        pages.insert(&mut txn, id.to_string(), "page");
    }

    for id in remove {
        pages.remove(&mut txn, &id.to_string());
    }

    drop(txn);
    let mut directory = note(space, shard, "index", &doc, rev);

    directory.parent = Some(space);
    save(device, directory);
}

async fn sync(device: &Device) -> Report {
    let http = kladde_sync::http().unwrap();
    let a = &device.access;
    let state = engine::remote_state(&http, a).await.unwrap();
    let mut report = Report::default();

    engine::sync_space(device, &http, a, &state, &mut report).await;

    report
}

async fn sync_latest(device: &Device) -> Report {
    let http = kladde_sync::http().unwrap();
    let mut report = Report::default();

    engine::sync_latest(device, &http, &device.access, &mut report)
        .await
        .unwrap();
    report
}

fn assert_clean(report: &Report) {
    assert!(report.failed.is_empty(), "failed: {:?}", report.failed);
    assert_eq!(report.stopped, None);
    assert_eq!(report.waiting, 0);
}

async fn register_for(origin: &Origin, space: Uuid) -> String {
    let user = format!("engine-{}", Uuid::new_v4());
    let http = kladde_sync::http().unwrap();

    register(&http, origin, &user, PASSWORD, space, &c::key())
        .await
        .unwrap();
    user
}

async fn setup() -> (Origin, String) {
    let base = std::env::var("KLADDE_TEST_RELAY").unwrap();
    let origin = Origin::parse(&base).unwrap();
    let user = register_for(&origin, Uuid::new_v4()).await;

    (origin, user)
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn two_devices_converge_after_concurrent_offline_edits() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let page = Uuid::new_v4();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "Mac schreibt. ");
    assert_clean(&sync(&mac).await);
    let first = sync(&phone).await;

    assert_clean(&first);
    assert!(first.changed.contains(&page));
    assert_eq!(read_text(&phone, page), "Mac schreibt. ");
    write_text(&mac, page, "Offline am Mac. ");
    write_text(&phone, page, "Offline am iPhone. ");
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    assert_clean(&sync(&mac).await);
    let merged = read_text(&mac, page);

    assert_eq!(merged, read_text(&phone, page));
    assert!(merged.contains("Offline am Mac."));
    assert!(merged.contains("Offline am iPhone."));
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn unchanged_documents_are_skipped_and_many_documents_sync() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let pages: Vec<Uuid> = (0..250).map(|_| Uuid::new_v4()).collect();

    list_pages(&mac, &pages, &[]);

    for (index, id) in pages.iter().enumerate() {
        write_text(&mac, *id, &format!("Seite {index}"));
    }

    assert_clean(&sync(&mac).await);
    let first = sync(&phone).await;

    assert_clean(&first);
    assert_eq!(first.changed.len(), pages.len() + 1);
    let again = sync(&phone).await;

    assert_clean(&again);
    assert!(again.changed.is_empty());
    write_text(&mac, pages[7], " geändert");
    assert_clean(&sync(&mac).await);
    let after = sync(&phone).await;

    assert_clean(&after);
    assert_eq!(after.changed, vec![pages[7]]);
    assert_eq!(read_text(&phone, pages[7]), "Seite 7 geändert");
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn expired_session_is_renewed_with_the_device_key() {
    let (origin, user) = setup().await;
    let mut mac = device(&origin, &user).await;
    let http = kladde_sync::http().unwrap();
    let stale = std::mem::replace(&mut mac.access.token, "0".repeat(64));

    assert!(matches!(
        engine::remote_state(&http, &mac.access).await,
        Err(Error::Auth)
    ));
    let fresh = kladde_sync::account::renew(&http, &origin, &mac.access)
        .await
        .unwrap();
    assert_ne!(fresh, stale);
    mac.access.token = stale;
    assert!(matches!(
        engine::remote_state(&http, &mac.access).await,
        Err(Error::Auth)
    ));
    mac.access.token = fresh;
    let page = Uuid::new_v4();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "Nach Erneuerung");
    assert_clean(&sync(&mac).await);
    let mut forged = device(&origin, &user).await;

    forged.access.device_key = *c::key();
    assert!(
        kladde_sync::account::renew(&http, &origin, &forged.access)
            .await
            .is_err()
    );
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn deleting_on_one_device_removes_the_page_everywhere() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let kept = Uuid::new_v4();
    let doomed = Uuid::new_v4();

    list_pages(&mac, &[kept, doomed], &[]);
    write_text(&mac, kept, "bleibt");
    write_text(&mac, doomed, "weg");
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    let (doc, rev) = load_doc(&mac, doomed);
    let mut trashed = note(mac.access.space, doomed, "page", &doc, rev);

    trashed.archived = true;
    save(&mac, trashed);
    mac.with(|s| s.forget(doomed)).unwrap();
    assert_clean(&sync(&mac).await);
    assert!(remote_has(&mac, doomed).await);
    list_pages(&mac, &[], &[doomed]);
    assert_clean(&sync(&mac).await);
    assert!(!remote_has(&mac, doomed).await);
    let report = sync(&phone).await;

    assert_clean(&report);
    assert_eq!(report.removed, vec![doomed]);
    assert!(phone.with(|s| s.get(doomed)).unwrap().is_none());
    assert_eq!(read_text(&phone, kept), "bleibt");
    write_text(&phone, kept, " und wächst");
    assert_clean(&sync(&phone).await);
    assert_clean(&sync(&mac).await);
    assert_eq!(read_text(&mac, kept), "bleibt und wächst");
}

async fn remote_has(device: &Device, id: Uuid) -> bool {
    let http = kladde_sync::http().unwrap();
    let state = engine::remote_state(&http, &device.access).await.unwrap();

    state.docs.iter().any(|(doc, _)| *doc == id)
}

fn erase(device: &Device, id: Uuid) {
    let (doc, rev) = load_doc(device, id);
    let mut trashed = note(device.access.space, id, "page", &doc, rev);

    trashed.archived = true;
    save(device, trashed);
    device.with(|s| s.forget(id)).unwrap();
    list_pages(device, &[], &[id]);
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn offline_edits_to_a_page_deleted_elsewhere_are_offered_for_rescue() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let page = Uuid::new_v4();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "Entwurf");
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    erase(&mac, page);
    write_text(&phone, page, " offline ergänzt");
    assert_clean(&sync(&mac).await);
    let report = sync(&phone).await;

    assert_eq!(report.rescue, vec![page]);
    assert!(report.removed.is_empty() && report.failed.is_empty());
    assert_eq!(read_text(&phone, page), "Entwurf offline ergänzt");
    let fresh = device(&origin, &user).await;

    assert_clean(&sync(&fresh).await);
    assert!(fresh.with(|s| s.get(page)).unwrap().is_none());
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_rolled_back_document_fails_alone_without_blocking_others() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let healthy = Uuid::new_v4();
    let broken = Uuid::new_v4();

    list_pages(&mac, &[healthy, broken], &[]);
    write_text(&mac, healthy, "a");
    write_text(&mac, broken, "b");
    assert_clean(&sync(&mac).await);
    let head = format!("head:{}:{}:{broken}", mac.access.account, mac.access.space);
    let mut cursor =
        kladde_sync::Cursor::decode(&mac.with(|s| s.state(&head)).unwrap().unwrap()).unwrap();
    cursor.seq += 5;
    let bytes = kladde_protocol::encode(&cursor).unwrap();

    mac.with(|s| s.set_state(&head, &bytes)).unwrap();
    write_text(&mac, healthy, "c");
    let report = sync(&mac).await;

    assert_eq!(report.failed, vec![broken]);
    assert_eq!(report.stopped, None);
    assert!(report.changed.contains(&healthy));
}

async fn sync_quick(device: &Device, hints: &[(Uuid, i64)]) -> Report {
    let http = kladde_sync::http().unwrap();
    let mut report = Report::default();

    engine::sync_changes(device, &http, &device.access, hints, &mut report).await;

    report
}

async fn next_notice(watch: &mut kladde_sync::watch::Watch) -> kladde_sync::watch::Notice {
    tokio::time::timeout(std::time::Duration::from_secs(10), watch.next())
        .await
        .expect("notice within ten seconds")
        .unwrap()
}

async fn changed_seq(watch: &mut kladde_sync::watch::Watch, wanted: Uuid) -> i64 {
    loop {
        if let kladde_sync::watch::Notice::Changed { doc, seq } = next_notice(watch).await
            && doc == wanted
        {
            return seq;
        }
    }
}

fn cursor_seq(device: &Device, id: Uuid) -> i64 {
    let head = format!(
        "head:{}:{}:{id}",
        device.access.account, device.access.space
    );
    let bytes = device.with(|s| s.state(&head)).unwrap().unwrap();

    kladde_sync::Cursor::decode(&bytes).unwrap().seq
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn watching_device_hears_about_pushes_and_deletions() {
    use kladde_sync::watch::{Notice, Watch};

    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let mut watch = Watch::open(&phone.access).await.unwrap();
    let page = Uuid::new_v4();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "live");
    assert_clean(&sync_quick(&mac, &[]).await);
    let seq = changed_seq(&mut watch, page).await;

    assert_eq!(seq, cursor_seq(&mac, page));
    erase(&mac, page);
    assert_clean(&sync(&mac).await);

    loop {
        if next_notice(&mut watch).await == Notice::Removed(page) {
            break;
        }
    }
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn quick_sync_pushes_edits_and_pulls_only_announced_pages() {
    use kladde_sync::watch::Watch;

    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let quiet = Uuid::new_v4();
    let page = Uuid::new_v4();

    list_pages(&mac, &[quiet, page], &[]);
    write_text(&mac, quiet, "ruhig");
    write_text(&mac, page, "eins");
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    let mut watch = Watch::open(&phone.access).await.unwrap();

    write_text(&mac, page, " zwei");
    let pushed = sync_quick(&mac, &[]).await;

    assert_clean(&pushed);
    assert_eq!(pushed.changed, vec![page]);
    let seq = changed_seq(&mut watch, page).await;
    let pulled = sync_quick(&phone, &[(page, seq)]).await;

    assert_clean(&pulled);
    assert_eq!(pulled.changed, vec![page]);
    assert_eq!(read_text(&phone, page), "eins zwei");
    let echo = sync_quick(&phone, &[(page, seq)]).await;

    assert_clean(&echo);
    assert!(echo.changed.is_empty());
    write_text(&phone, page, " drei");
    write_text(&mac, page, " vier");
    assert_clean(&sync_quick(&phone, &[]).await);
    assert_clean(&sync_quick(&mac, &[]).await);
    assert_clean(&sync(&phone).await);
    let merged = read_text(&mac, page);

    assert_eq!(merged, read_text(&phone, page));
    assert!(merged.contains("drei") && merged.contains("vier"));
    let fresh = device(&origin, &user).await;

    assert_clean(&sync(&fresh).await);
    assert_eq!(read_text(&fresh, page), merged);
    assert_eq!(read_text(&fresh, quiet), "ruhig");
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_broken_document_in_a_batch_does_not_stop_the_others() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let pages: Vec<Uuid> = (0..40).map(|_| Uuid::new_v4()).collect();

    list_pages(&mac, &pages, &[]);

    for (index, id) in pages.iter().enumerate() {
        write_text(&mac, *id, &format!("Seite {index}"));
    }

    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);

    for id in &pages {
        write_text(&mac, *id, " neu");
    }

    assert_clean(&sync(&mac).await);
    let broken = pages[3];
    let head = format!(
        "head:{}:{}:{broken}",
        phone.access.account, phone.access.space
    );
    let mut cursor =
        kladde_sync::Cursor::decode(&phone.with(|s| s.state(&head)).unwrap().unwrap()).unwrap();
    cursor.seq += 5;
    let bytes = kladde_protocol::encode(&cursor).unwrap();

    phone.with(|s| s.set_state(&head, &bytes)).unwrap();
    let report = sync(&phone).await;

    assert_eq!(report.failed, vec![broken]);
    assert_eq!(report.stopped, None);
    assert_eq!(report.changed.len(), pages.len() - 1);

    for (index, id) in pages.iter().enumerate().filter(|(_, id)| **id != broken) {
        assert_eq!(read_text(&phone, *id), format!("Seite {index} neu"));
    }
}

async fn grow_history(device: &Device, id: Uuid) {
    for round in 0..HISTORY_ROUNDS {
        if round == CHECKPOINT_ROUND {
            force_snapshot(device, id);
        }

        write_text(device, id, &format!(" {round}"));
        assert_clean(&sync(device).await);
    }
}

async fn served_from_start(device: &Device, id: Uuid) -> Vec<i64> {
    use kladde_protocol::{Client, Server};

    let mut socket = kladde_sync::Socket::connect(&device.access).await.unwrap();

    socket
        .send(&Client::Subscribe {
            space: device.access.space,
            doc: id,
            last_seq: 0,
            known_snapshot: None,
        })
        .await
        .unwrap();
    let mut served = Vec::new();

    loop {
        match socket.receive().await.unwrap() {
            Server::Item { seq, .. } => served.push(seq),
            Server::Head { .. } => return served,
            _ => panic!("unexpected relay response"),
        }
    }
}

const HISTORY_ROUNDS: usize = 9;
const CHECKPOINT_ROUND: usize = 6;

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_fresh_device_starts_at_the_latest_checkpoint_and_a_late_one_catches_up() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let page = Uuid::new_v4();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "Anfang");
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    grow_history(&mac, page).await;
    let late = sync(&phone).await;

    assert_clean(&late);
    assert_eq!(late.changed, vec![page]);
    let expected = read_text(&mac, page);

    assert_eq!(read_text(&phone, page), expected);
    let fresh = device(&origin, &user).await;

    assert_clean(&sync(&fresh).await);
    assert_eq!(read_text(&fresh, page), expected);
    let served = served_from_start(&fresh, page).await;

    assert!(served[0] > 1, "history was not trimmed: {served:?}");
    assert_eq!(served.len(), HISTORY_ROUNDS - CHECKPOINT_ROUND);
    assert_eq!(*served.last().unwrap(), cursor_seq(&mac, page));
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_lost_acknowledgement_settles_after_the_history_was_trimmed() {
    use kladde_protocol::Server;

    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let page = Uuid::new_v4();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "Basis");
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    write_text(&phone, page, " vom Telefon");
    let a = &phone.access;
    let head = format!("head:{}:{}:{page}", a.account, a.space);
    let cursor =
        kladde_sync::Cursor::decode(&phone.with(|s| s.state(&head)).unwrap().unwrap()).unwrap();
    let (queued, rev) = phone.with(|s| s.queued(page)).unwrap().unwrap();
    let bytes = kladde_protocol::encode(&kladde_store::wire_form(queued)).unwrap();
    let request = cursor.push_with(a, page, &bytes, true).unwrap();
    let pending = kladde_protocol::encode(&(rev, request.clone())).unwrap();

    phone
        .with(|s| s.set_state(&format!("wire:{}:{page}", a.account), &pending))
        .unwrap();
    let mut socket = kladde_sync::Socket::connect(a).await.unwrap();

    socket.send(&request).await.unwrap();
    assert!(matches!(
        socket.receive().await.unwrap(),
        Server::Ack { .. }
    ));
    drop(socket);
    grow_history(&mac, page).await;
    assert!(served_from_start(&mac, page).await[0] > 1);
    let settled = sync(&phone).await;

    assert_clean(&settled);
    assert!(phone.with(|s| s.outbox(a.space)).unwrap().is_empty());
    let merged = read_text(&mac, page);

    assert!(merged.contains("vom Telefon"));
    assert_eq!(read_text(&phone, page), merged);
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_device_does_not_hear_its_own_pushes() {
    use kladde_sync::watch::{Notice, Watch};

    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let (own, other) = (Uuid::new_v4(), Uuid::new_v4());

    list_pages(&mac, &[own, other], &[]);
    write_text(&mac, own, "eigen");
    write_text(&mac, other, "fremd");
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    let mut watch = Watch::open(&mac.access).await.unwrap();

    write_text(&mac, own, " neu");
    assert_clean(&sync_quick(&mac, &[]).await);
    write_text(&phone, other, " neu");
    assert_clean(&sync_quick(&phone, &[]).await);

    match next_notice(&mut watch).await {
        Notice::Changed { doc, .. } => assert_eq!(doc, other),
        notice => panic!("unexpected notice {notice:?}"),
    }
}

fn force_snapshot(device: &Device, id: Uuid) {
    let a = &device.access;
    let head = format!("head:{}:{}:{id}", a.account, a.space);
    let mut cursor =
        kladde_sync::Cursor::decode(&device.with(|s| s.state(&head)).unwrap().unwrap()).unwrap();
    cursor.updates = 64;
    let bytes = kladde_protocol::encode(&cursor).unwrap();

    device.with(|s| s.set_state(&head, &bytes)).unwrap();
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn simultaneous_snapshots_settle_without_failures() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let page = Uuid::new_v4();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "Start");
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);

    for round in 0..4 {
        write_text(&mac, page, &format!(" mac{round}"));
        write_text(&phone, page, &format!(" phone{round}"));
        force_snapshot(&mac, page);
        force_snapshot(&phone, page);
        let (first, second) = tokio::join!(sync(&mac), sync(&phone));

        for report in [&first, &second] {
            assert_clean(report);
            assert!(report.retry.is_empty(), "retry: {:?}", report.retry);
        }
    }

    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    let merged = read_text(&mac, page);

    assert_eq!(read_text(&phone, page), merged);
    assert!(merged.contains("mac3") && merged.contains("phone3"));
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_full_account_is_reported_and_keeps_the_changes() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let pages: Vec<Uuid> = (0..7).map(|_| Uuid::new_v4()).collect();

    list_pages(&mac, &pages, &[]);
    let large = "x".repeat(1_500_000);

    for id in &pages {
        write_text(&mac, *id, &large);
    }

    let report = sync(&mac).await;

    assert_eq!(report.stopped, Some("full"));
    assert!(!report.failed.is_empty());
    assert_eq!(report.waiting, report.failed.len());
    let received = sync(&phone).await;

    assert_clean(&received);
    let arrived = pages
        .iter()
        .filter(|id| phone.with(|s| s.get(**id)).unwrap().is_some())
        .count();
    assert_eq!(arrived, pages.len() - report.failed.len());
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn an_edit_after_a_sealed_envelope_goes_out_in_the_same_run() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let pages: Vec<Uuid> = (0..7).map(|_| Uuid::new_v4()).collect();

    list_pages(&mac, &pages, &[]);
    let large = "x".repeat(1_500_000);

    for id in &pages {
        write_text(&mac, *id, &large);
    }

    let full = sync(&mac).await;

    assert_eq!(full.stopped, Some("full"));
    let late = full.failed[0];

    write_text(&mac, late, "geht raus");
    let sent = pages.iter().filter(|id| !full.failed.contains(id));

    for id in sent.take(full.failed.len() + 1) {
        erase(&mac, *id);
    }

    sync(&mac).await;
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    assert!(read_text(&phone, late).ends_with("geht raus"));
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_broken_document_in_a_push_batch_does_not_stop_the_others() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let pages: Vec<Uuid> = (0..40).map(|_| Uuid::new_v4()).collect();

    list_pages(&mac, &pages, &[]);

    for (index, id) in pages.iter().enumerate() {
        write_text(&mac, *id, &format!("Seite {index}"));
    }

    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);

    for id in &pages {
        write_text(&phone, *id, " vom Telefon");
    }

    let broken = pages[5];
    let a = &phone.access;
    let head = format!("head:{}:{}:{broken}", a.account, a.space);
    let mut cursor =
        kladde_sync::Cursor::decode(&phone.with(|s| s.state(&head)).unwrap().unwrap()).unwrap();
    cursor.seq += 5;
    let bytes = kladde_protocol::encode(&cursor).unwrap();

    phone.with(|s| s.set_state(&head, &bytes)).unwrap();
    let report = sync(&phone).await;

    assert_eq!(report.failed, vec![broken]);
    assert_eq!(report.stopped, None);
    assert_eq!(report.waiting, 1);
    assert_clean(&sync(&mac).await);

    for (index, id) in pages.iter().enumerate().filter(|(_, id)| **id != broken) {
        assert_eq!(read_text(&mac, *id), format!("Seite {index} vom Telefon"));
    }
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_deletion_relisted_by_an_edit_elsewhere_is_taken_back() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let page = Uuid::new_v4();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "alt");
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    list_pages(&mac, &[], &[page]);
    mac.with(|s| s.forget(page)).unwrap();
    write_text(&phone, page, " wiederbelebt");
    list_pages(&phone, &[page], &[]);
    assert_clean(&sync(&phone).await);
    assert_clean(&sync(&mac).await);
    let held = mac.with(|s| s.deletions(mac.access.space)).unwrap();

    assert!(held.is_empty());
    assert_eq!(read_text(&mac, page), "alt wiederbelebt");
    assert!(remote_has(&mac, page).await);
    assert_clean(&sync(&phone).await);
    assert_eq!(read_text(&phone, page), "alt wiederbelebt");
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn unlisting_before_forgetting_deletes_the_page_everywhere() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let page = Uuid::new_v4();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "weg");
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    list_pages(&mac, &[], &[page]);
    mac.with(|s| s.forget(page)).unwrap();
    assert_clean(&sync(&mac).await);
    assert!(!remote_has(&mac, page).await);
    let report = sync(&phone).await;

    assert_clean(&report);
    assert_eq!(report.removed, vec![page]);
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn stuck_pages_are_left_out_of_quick_runs() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let (stuck_page, free_page) = (Uuid::new_v4(), Uuid::new_v4());

    list_pages(&mac, &[stuck_page, free_page], &[]);
    write_text(&mac, stuck_page, "eins");
    write_text(&mac, free_page, "zwei");
    assert_clean(&sync(&mac).await);
    let before = cursor_seq(&mac, stuck_page);

    write_text(&mac, stuck_page, " bleibt liegen");
    write_text(&mac, free_page, " geht raus");
    let http = kladde_sync::http().unwrap();
    let stuck = BTreeSet::from([stuck_page]);
    let mut report = Report::default();

    engine::sync_changes_except(&mac, &http, &mac.access, &[], &stuck, &mut report).await;
    assert!(report.failed.is_empty());
    assert_eq!(report.waiting, 1);
    assert_eq!(cursor_seq(&mac, stuck_page), before);
    assert_clean(&sync_quick(&mac, &[]).await);
    assert_eq!(cursor_seq(&mac, stuck_page), before + 1);
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_page_listed_in_a_directory_document_is_deleted_after_it_is_unlisted() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let (page, shard) = (Uuid::new_v4(), Uuid::new_v4());

    list_pages(&mac, &[], &[]);
    list_in_directory(&mac, shard, &[page], &[]);
    write_text(&mac, page, "im Verzeichnis");
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    assert!(
        phone
            .with(|s| s.is_listed(phone.access.space, page))
            .unwrap()
    );
    let (doc, rev) = load_doc(&mac, page);
    let mut trashed = note(mac.access.space, page, "page", &doc, rev);

    trashed.archived = true;
    save(&mac, trashed);
    mac.with(|s| s.forget(page)).unwrap();
    assert_clean(&sync(&mac).await);
    assert!(remote_has(&mac, page).await);
    list_in_directory(&mac, shard, &[], &[page]);
    assert_clean(&sync(&mac).await);
    assert!(!remote_has(&mac, page).await);
    let report = sync(&phone).await;

    assert_clean(&report);
    assert_eq!(report.removed, vec![page]);
    assert!(remote_has(&phone, shard).await);
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn later_runs_only_look_at_what_changed_since_the_last_one() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let (quiet, busy, doomed) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());

    list_pages(&mac, &[quiet, busy, doomed], &[]);

    for id in [quiet, busy, doomed] {
        write_text(&mac, id, "Anfang");
    }

    assert_clean(&sync_latest(&mac).await);
    assert_clean(&sync_latest(&phone).await);
    let a = &phone.access;
    let head = format!("head:{}:{}:{quiet}", a.account, a.space);
    let mut cursor =
        kladde_sync::Cursor::decode(&phone.with(|s| s.state(&head)).unwrap().unwrap()).unwrap();
    cursor.seq += 5;
    let bytes = kladde_protocol::encode(&cursor).unwrap();

    phone.with(|s| s.set_state(&head, &bytes)).unwrap();
    write_text(&mac, busy, " nur das Neue");
    erase(&mac, doomed);
    assert_clean(&sync_latest(&mac).await);
    let report = sync_latest(&phone).await;

    assert_clean(&report);
    assert_eq!(report.removed, vec![doomed]);
    assert_eq!(read_text(&phone, busy), "Anfang nur das Neue");
    assert_eq!(sync(&phone).await.failed, vec![quiet]);
}

fn database_with_rows(device: &Device, count: usize) -> (Uuid, Vec<Uuid>) {
    let space = device.access.space;
    let database = Uuid::new_v4();
    let rows: Vec<Uuid> = (0..count).map(|_| Uuid::new_v4()).collect();

    list_pages(device, &[database], &[]);
    save(device, note(space, database, "database", &Doc::new(), 0));

    for row in &rows {
        let mut stored = note(space, *row, "row", &Doc::new(), 0);

        stored.parent = Some(database);
        save(device, stored);
    }

    (database, rows)
}

fn forget_database(device: &Device, database: Uuid) {
    list_pages(device, &[], &[database]);
    device.with(|s| s.forget(database)).unwrap();
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn deleting_a_database_takes_its_rows_along_with_a_single_mark() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let (database, rows) = database_with_rows(&mac, 40);

    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    assert!(phone.with(|s| s.get(rows[9])).unwrap().is_some());
    forget_database(&mac, database);
    assert_clean(&sync(&mac).await);
    let http = kladde_sync::http().unwrap();
    let state = engine::remote_state(&http, &mac.access).await.unwrap();

    assert_eq!(state.deleted, vec![database]);
    assert!(state.docs.iter().all(|(id, _)| !rows.contains(id)));
    let report = sync(&phone).await;

    assert_clean(&report);
    assert_eq!(report.removed, vec![database]);
    assert!(phone.with(|s| s.get(rows[9])).unwrap().is_none());
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_row_edited_offline_rescues_its_deleted_database() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let (database, rows) = database_with_rows(&mac, 3);

    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    let (doc, rev) = load_doc(&phone, rows[1]);
    let body = doc.get_or_insert_text("body");

    body.insert(&mut doc.transact_mut(), 0, "unterwegs ergänzt");
    let mut edited = note(phone.access.space, rows[1], "row", &doc, rev);

    edited.parent = Some(database);
    save(&phone, edited);
    forget_database(&mac, database);
    assert_clean(&sync(&mac).await);
    let report = sync(&phone).await;

    assert_eq!(report.rescue, vec![database]);
    assert!(phone.with(|s| s.get(rows[1])).unwrap().is_some());
}

fn rows_present(device: &Device, rows: &[Uuid]) -> usize {
    rows.iter()
        .filter(|row| device.with(|s| s.get(**row)).unwrap().is_some())
        .count()
}

fn edit_row(device: &Device, database: Uuid, row: Uuid, text: &str) {
    let (doc, rev) = load_doc(device, row);
    let body = doc.get_or_insert_text("body");

    body.insert(&mut doc.transact_mut(), 0, text);
    let mut edited = note(device.access.space, row, "row", &doc, rev);

    edited.parent = Some(database);
    save(device, edited);
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn rows_of_a_deleted_database_stay_gone_on_the_deleting_device() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let (database, rows) = database_with_rows(&mac, 5);

    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    forget_database(&mac, database);
    assert_clean(&sync(&mac).await);
    assert_eq!(rows_present(&mac, &rows), 0);
    assert_clean(&sync(&mac).await);
    assert_clean(&sync_latest(&mac).await);
    assert!(!remote_has(&mac, rows[0]).await);
    let received = sync(&phone).await;

    assert_clean(&received);
    assert_eq!(received.removed, vec![database]);
    assert_eq!(rows_present(&phone, &rows), 0);
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn recently_pushed_rows_of_a_deleted_database_stay_gone_in_a_marked_run() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let (database, rows) = database_with_rows(&mac, 5);

    assert_clean(&sync_latest(&mac).await);
    assert_clean(&sync_latest(&mac).await);
    edit_row(&mac, database, rows[2], "unterwegs ergänzt");
    assert_clean(&sync_quick(&mac, &[]).await);
    forget_database(&mac, database);
    assert_clean(&sync_latest(&mac).await);
    assert_eq!(rows_present(&mac, &rows), 0);
    assert_clean(&sync_latest(&mac).await);
    assert_clean(&sync(&mac).await);
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn an_edit_saved_while_a_deletion_arrives_is_rescued() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let page = Uuid::new_v4();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "Entwurf");
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    erase(&mac, page);
    assert_clean(&sync(&mac).await);
    *phone.edit_on_listing.lock().unwrap() = Some((page, " während des Abrufs"));
    let report = sync(&phone).await;

    assert_eq!(report.rescue, vec![page]);
    assert!(report.removed.is_empty());
    assert_eq!(read_text(&phone, page), "Entwurf während des Abrufs");
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn rows_return_in_a_marked_run_when_their_database_is_relisted() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let (database, rows) = database_with_rows(&mac, 5);

    assert_clean(&sync_latest(&mac).await);
    assert_clean(&sync_latest(&mac).await);
    assert_clean(&sync_latest(&phone).await);
    assert_eq!(rows_present(&phone, &rows), 5);
    forget_database(&mac, database);
    assert_eq!(rows_present(&mac, &rows), 0);
    let (doc, rev) = load_doc(&phone, database);

    doc.get_or_insert_text("body")
        .insert(&mut doc.transact_mut(), 0, "zurückgeholt");
    let edited = note(phone.access.space, database, "database", &doc, rev);

    save(&phone, edited);
    list_pages(&phone, &[database], &[]);
    assert_clean(&sync_latest(&phone).await);
    assert_clean(&sync_latest(&mac).await);
    assert!(mac.with(|s| s.get(database)).unwrap().is_some());
    assert_eq!(rows_present(&mac, &rows), 5);
    assert_clean(&sync_latest(&mac).await);
    assert_eq!(rows_present(&mac, &rows), 5);
    assert_clean(&sync_latest(&phone).await);
    assert_eq!(rows_present(&phone, &rows), 5);
}

async fn push_newer_format(device: &Device, id: Uuid) {
    use kladde_protocol::{Server, compat};

    let a = &device.access;
    let head = format!("head:{}:{}:{id}", a.account, a.space);
    let cursor =
        kladde_sync::Cursor::decode(&device.with(|s| s.state(&head)).unwrap().unwrap()).unwrap();
    let writing = kladde_sync::Writing {
        checkpoints: false,
        format: compat::FORMAT + 1,
    };

    let request = cursor.push_as(a, id, b"from a later app", writing).unwrap();
    let mut socket = kladde_sync::Socket::connect(a).await.unwrap();

    socket.send(&request).await.unwrap();
    assert!(matches!(
        socket.receive().await.unwrap(),
        Server::Ack { .. }
    ));
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn pages_from_a_newer_app_keep_local_changes_and_spare_the_rest() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let later = device(&origin, &user).await;
    let (page, other) = (Uuid::new_v4(), Uuid::new_v4());

    list_pages(&mac, &[page, other], &[]);
    write_text(&mac, page, "Basis");
    write_text(&mac, other, "anders");
    let first = sync_latest(&mac).await;

    assert_clean(&first);
    assert_eq!(first.behind, Some(Vec::new()));
    assert_clean(&sync_latest(&phone).await);
    assert_clean(&sync_latest(&later).await);
    write_text(&mac, other, " neu");
    assert_clean(&sync_latest(&mac).await);
    push_newer_format(&later, page).await;
    write_text(&phone, page, " unterwegs ergänzt");

    let report = sync_latest(&phone).await;

    assert_eq!(report.newer, vec![page]);
    assert_eq!(report.failed, vec![page]);
    assert_eq!(report.stopped, None);
    assert_eq!(report.waiting, 1);
    assert_eq!(read_text(&phone, other), "anders neu");
    assert_eq!(read_text(&phone, page), "Basis unterwegs ergänzt");

    let quick = sync_quick(&phone, &[]).await;

    assert_eq!(quick.behind, None);
    assert_eq!(quick.newer, vec![page]);
    assert_eq!(quick.waiting, 1);
    assert_eq!(read_text(&phone, page), "Basis unterwegs ergänzt");
    let outbox = phone.with(|s| s.outbox(phone.access.space)).unwrap();

    assert_eq!(outbox, vec![page]);
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn an_unreadable_manifest_defers_deletions_made_elsewhere() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let page = Uuid::new_v4();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "ruhig");
    assert_clean(&sync(&mac).await);
    assert_clean(&sync(&phone).await);
    push_newer_format(&mac, mac.access.space).await;
    purge_signed(&mac.access, page).await;
    let report = sync(&phone).await;

    assert!(report.removed.is_empty());
    assert!(report.rescue.is_empty());
    assert_eq!(report.newer, vec![phone.access.space]);
    assert_eq!(read_text(&phone, page), "ruhig");
    let later = sync_latest(&phone).await;

    assert!(later.removed.is_empty());
    assert!(later.rescue.is_empty());
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn an_incompatible_run_stops_before_it_touches_anything() {
    use kladde_protocol::compat::Side;

    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let page = Uuid::new_v4();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "bleibt liegen");
    let cases = [
        ("kladde-protocol", "200-201", Side::Server),
        ("kladde-features", "full,outdated", Side::App),
    ];

    for (name, value, side) in cases {
        let mut headers = reqwest::header::HeaderMap::new();

        headers.insert(name, value.parse().unwrap());
        let http = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .unwrap();
        let mut report = Report::default();
        let outcome = engine::sync_latest(&mac, &http, &mac.access, &mut report).await;

        assert!(matches!(outcome, Err(Error::Outdated(s)) if s == side));
        assert_eq!(
            engine::error_code(&outcome.unwrap_err()),
            match side {
                Side::App => "outdated_app",
                Side::Server => "outdated_server",
            }
        );
    }

    let outbox = mac.with(|s| s.outbox(mac.access.space)).unwrap();

    assert_eq!(outbox.len(), 2);
    assert_clean(&sync_latest(&mac).await);
}

async fn purge_signed(access: &Access, doc: Uuid) {
    use ed25519_dalek::{Signer, SigningKey};
    use kladde_protocol::account::{PROOF_HEADER, purge_message};

    let message = purge_message(access.account, access.space, doc).unwrap();
    let proof: String = SigningKey::from_bytes(&access.device_key)
        .sign(&message)
        .to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let url = url::Url::parse(&access.origin)
        .unwrap()
        .join(&format!("v1/spaces/{}/docs/{doc}", access.space))
        .unwrap();
    let purged = kladde_sync::http()
        .unwrap()
        .delete(url)
        .bearer_auth(&access.token)
        .header(PROOF_HEADER, proof)
        .send()
        .await
        .unwrap();

    assert!(purged.status().is_success());
}

async fn erase_account(device: &Device) {
    let http = kladde_sync::http().unwrap();
    let origin = Origin::parse(&device.access.origin).unwrap();

    kladde_sync::account::erase(&http, &origin, &device.access, PASSWORD)
        .await
        .unwrap();
}

async fn moved_to_new_account(origin: &Origin, device: Device) -> (Device, String) {
    let space = device.access.space;

    erase_account(&device).await;
    let user = register_for(origin, space).await;
    let access = signed_in(origin, &user).await;

    (Device { access, ..device }, user)
}

async fn joined(origin: &Origin, user: &str, device: Device) -> Device {
    let access = signed_in(origin, user).await;

    Device { access, ..device }
}

fn listed_pages(device: &Device) -> Vec<String> {
    let (doc, _) = load_doc(device, device.access.space);
    let pages = doc.get_or_insert_map("pages");
    let mut listed: Vec<String> = pages.keys(&doc.transact()).map(str::to_string).collect();

    listed.sort();

    listed
}

async fn remember_mark_like_an_older_app(device: &Device) {
    let http = kladde_sync::http().unwrap();
    let a = &device.access;
    let mark = engine::remote_state(&http, a).await.unwrap().mark.unwrap();
    let bytes = kladde_protocol::encode(&(mark, a.epoch())).unwrap();

    assert!(mark > 0);
    device
        .with(|s| s.set_state(&format!("relay:{}:{}:mark", a.account, a.space), &bytes))
        .unwrap();
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_device_uploads_its_whole_notebook_to_a_new_account() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let pages: Vec<Uuid> = (0..3).map(|_| Uuid::new_v4()).collect();

    list_pages(&mac, &pages, &[]);

    for (index, id) in pages.iter().enumerate() {
        write_text(&mac, *id, &format!("vor dem Wechsel {index}"));
    }

    assert_clean(&sync_latest(&mac).await);
    let (mac, user) = moved_to_new_account(&origin, mac).await;

    assert_clean(&sync_latest(&mac).await);
    let phone = device(&origin, &user).await;

    assert_clean(&sync_latest(&phone).await);
    assert_eq!(listed_pages(&phone), listed_pages(&mac));

    for (index, id) in pages.iter().enumerate() {
        assert_eq!(read_text(&phone, *id), format!("vor dem Wechsel {index}"));
    }
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_device_with_an_older_copy_uploads_what_only_it_has() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let (shared, own) = (Uuid::new_v4(), Uuid::new_v4());

    list_pages(&mac, &[shared], &[]);
    write_text(&mac, shared, "gemeinsam");
    assert_clean(&sync_latest(&mac).await);
    assert_clean(&sync_latest(&phone).await);
    list_pages(&phone, &[own], &[]);
    write_text(&phone, own, "nur am Telefon");
    write_text(&phone, shared, " und ergänzt");
    assert_clean(&sync_latest(&phone).await);
    let (mac, user) = moved_to_new_account(&origin, mac).await;
    let phone = joined(&origin, &user, phone).await;

    assert_clean(&sync_latest(&mac).await);
    assert_clean(&sync_latest(&phone).await);
    assert_clean(&sync_latest(&mac).await);
    assert_eq!(read_text(&mac, own), "nur am Telefon");
    assert_eq!(read_text(&mac, shared), "gemeinsam und ergänzt");
    assert_eq!(listed_pages(&mac), listed_pages(&phone));
    let tablet = device(&origin, &user).await;

    assert_clean(&sync_latest(&tablet).await);
    assert_eq!(listed_pages(&tablet), listed_pages(&phone));
    assert_eq!(read_text(&tablet, own), "nur am Telefon");
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_device_that_already_remembers_a_mark_still_uploads_everything() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let (edited, untouched) = (Uuid::new_v4(), Uuid::new_v4());

    list_pages(&mac, &[edited, untouched], &[]);
    write_text(&mac, edited, "ungesichert eins");
    write_text(&mac, untouched, "ungesichert zwei");
    assert_clean(&sync_latest(&mac).await);
    let (mac, user) = moved_to_new_account(&origin, mac).await;

    write_text(&mac, edited, " neu");
    assert_clean(&sync_quick(&mac, &[]).await);
    remember_mark_like_an_older_app(&mac).await;
    assert_clean(&sync_latest(&mac).await);

    for id in [mac.access.space, edited, untouched] {
        assert!(remote_has(&mac, id).await, "{id} was not uploaded");
    }

    let phone = device(&origin, &user).await;

    assert_clean(&sync_latest(&phone).await);
    assert_eq!(read_text(&phone, edited), "ungesichert eins neu");
    assert_eq!(read_text(&phone, untouched), "ungesichert zwei");
    let again = sync_latest(&mac).await;

    assert_clean(&again);
    assert!(again.changed.is_empty(), "changed: {:?}", again.changed);
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_page_deleted_in_the_new_account_is_not_brought_back_by_an_older_copy() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let (kept, doomed) = (Uuid::new_v4(), Uuid::new_v4());

    list_pages(&mac, &[kept, doomed], &[]);
    write_text(&mac, kept, "überlebt den Wechsel");
    write_text(&mac, doomed, "im neuen Konto gelöscht");
    assert_clean(&sync_latest(&mac).await);
    assert_clean(&sync_latest(&phone).await);
    let (mac, user) = moved_to_new_account(&origin, mac).await;

    assert_clean(&sync_latest(&mac).await);
    erase(&mac, doomed);
    assert_clean(&sync_latest(&mac).await);
    assert!(!remote_has(&mac, doomed).await);
    let phone = joined(&origin, &user, phone).await;
    let report = sync_latest(&phone).await;

    assert_clean(&report);
    assert!(report.rescue.is_empty(), "rescue: {:?}", report.rescue);
    assert_eq!(report.removed, vec![doomed]);
    assert!(phone.with(|s| s.get(doomed)).unwrap().is_none());
    assert!(!remote_has(&phone, doomed).await);
    assert_eq!(read_text(&phone, kept), "überlebt den Wechsel");
    assert_clean(&sync_latest(&mac).await);
    assert_eq!(listed_pages(&mac), listed_pages(&phone));
}

fn file_rows(device: &Device, database: Uuid, rows: &[Uuid]) {
    let directory = Doc::new();
    let listed = directory.get_or_insert_map("pages");

    for row in rows {
        listed.insert(&mut directory.transact_mut(), row.to_string(), "row");
    }

    let mut index = note(device.access.space, Uuid::new_v4(), "index", &directory, 0);

    index.parent = Some(database);
    save(device, index);
}

fn move_cursor_ahead(device: &Device, id: Uuid, by: i64) {
    let a = &device.access;
    let head = format!("head:{}:{}:{id}", a.account, a.space);
    let stored = device.with(|s| s.state(&head)).unwrap().unwrap();
    let mut cursor = kladde_sync::Cursor::decode(&stored).unwrap();

    cursor.seq += by;
    let bytes = kladde_protocol::encode(&cursor).unwrap();

    device.with(|s| s.set_state(&head, &bytes)).unwrap();
}

async fn repaired(device: &Device) -> Report {
    engine::resync(device, &device.access).unwrap();

    sync_latest(device).await
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn rows_of_a_database_deleted_elsewhere_never_count_as_failed() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let (database, rows) = database_with_rows(&mac, 3);

    file_rows(&mac, database, &rows);
    assert_clean(&sync_latest(&mac).await);
    assert_clean(&sync_latest(&phone).await);
    edit_row(&phone, database, rows[1], "unterwegs gerettet");
    forget_database(&mac, database);
    assert_clean(&sync_latest(&mac).await);
    let marked = sync_latest(&phone).await;

    assert_eq!(marked.rescue, vec![database]);
    assert!(marked.failed.is_empty(), "failed: {:?}", marked.failed);
    let full = sync(&phone).await;

    assert_eq!(full.rescue, vec![database]);
    assert!(full.failed.is_empty(), "failed: {:?}", full.failed);
    assert!(phone.with(|s| s.get(rows[1])).unwrap().is_some());
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_repair_brings_every_device_back_in_step_after_a_relay_restore() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let phone = device(&origin, &user).await;
    let (restored, untouched) = (Uuid::new_v4(), Uuid::new_v4());

    list_pages(&mac, &[restored, untouched], &[]);
    write_text(&mac, restored, "vor der Wiederherstellung");
    write_text(&mac, untouched, "unberührt");
    assert_clean(&sync_latest(&mac).await);
    assert_clean(&sync_latest(&phone).await);
    move_cursor_ahead(&mac, restored, 5);
    move_cursor_ahead(&phone, restored, 5);
    write_text(&mac, restored, " und danach");
    assert_eq!(sync(&mac).await.failed, vec![restored]);
    assert_eq!(sync(&phone).await.failed, vec![restored]);
    assert_clean(&repaired(&mac).await);
    assert_clean(&repaired(&phone).await);
    assert_clean(&sync_latest(&mac).await);
    let expected = "vor der Wiederherstellung und danach";

    assert_eq!(read_text(&mac, restored), expected);
    assert_eq!(read_text(&phone, restored), expected);
    let fresh = device(&origin, &user).await;

    assert_clean(&sync_latest(&fresh).await);
    assert_eq!(read_text(&fresh, restored), expected);
    assert_eq!(read_text(&fresh, untouched), "unberührt");
    assert_clean(&sync_latest(&phone).await);
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_device_signing_in_after_a_key_change_reads_the_history_before_it() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let page = Uuid::new_v4();
    let http = kladde_sync::http().unwrap();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "vor dem Wechsel");
    assert_clean(&sync(&mac).await);
    rekey(
        &http,
        &origin,
        &user,
        Proof::Password(PASSWORD),
        PASSWORD,
        &c::key(),
    )
    .await
    .unwrap();
    let phone = device(&origin, &user).await;

    phone
        .with(|s| engine::remember_fresh_sign_in(s, &phone.access))
        .unwrap();
    assert_clean(&sync_latest(&phone).await);
    assert_eq!(read_text(&phone, page), "vor dem Wechsel");
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_key_change_is_refused_when_a_notebook_changed_after_its_heads_were_read() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let page = Uuid::new_v4();
    let http = kladde_sync::http().unwrap();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "vor dem Wechsel");
    assert_clean(&sync(&mac).await);
    let late = prepare_rekey(
        &http,
        &origin,
        &user,
        Proof::Password(PASSWORD),
        PASSWORD,
        &c::key(),
    )
    .await
    .unwrap();

    write_text(&mac, page, " überlebt den Wechsel");
    assert_clean(&sync(&mac).await);
    assert!(matches!(late.send(&http, &origin).await, Err(Error::Stale)));
    rekey(
        &http,
        &origin,
        &user,
        Proof::Password(PASSWORD),
        PASSWORD,
        &c::key(),
    )
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "uses an isolated PostgreSQL relay; run scripts/test-relay.sh"]
async fn a_device_signing_in_after_two_key_changes_reads_the_history_before_them() {
    let (origin, user) = setup().await;
    let mac = device(&origin, &user).await;
    let page = Uuid::new_v4();
    let http = kladde_sync::http().unwrap();

    list_pages(&mac, &[page], &[]);
    write_text(&mac, page, "vor dem Wechsel");
    assert_clean(&sync(&mac).await);

    for _ in 0..2 {
        rekey(
            &http,
            &origin,
            &user,
            Proof::Password(PASSWORD),
            PASSWORD,
            &c::key(),
        )
        .await
        .unwrap();
    }

    let phone = device(&origin, &user).await;

    phone
        .with(|s| engine::remember_fresh_sign_in(s, &phone.access))
        .unwrap();
    assert_clean(&sync_latest(&phone).await);
    assert_eq!(read_text(&phone, page), "vor dem Wechsel");
}
