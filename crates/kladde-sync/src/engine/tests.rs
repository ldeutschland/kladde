use super::doc_exchange::pull;
use super::doc_state_keys::DocKeys;
use super::pending_pushes::{Pending, acknowledge, envelope, prepare_push};
use super::remote_removals::{remove_deleted, signed_among};
use super::report::Report;
use super::{Local, local_error};
use crate::{Cursor, Error, Socket, Writing, account::Access};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use kladde_crypto as c;
use kladde_protocol::{
    self as p, Certificate, Server,
    account::{SpaceState, Tombstone, purge_message},
    compat,
};

use kladde_store::{Note, Store};
use std::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;
use yrs::{Any, Doc, Map, ReadTxn, StateVector, Text, Transact};

const WRITING: Writing = Writing {
    checkpoints: false,
    format: compat::LEGACY_FORMAT,
};

struct Device(Mutex<Store>);

impl Local for Device {
    fn with<T>(
        &self,
        work: impl FnOnce(&mut Store) -> Result<T, kladde_store::Error>,
    ) -> Result<T, Error> {
        let mut store = self.0.lock().map_err(|_| Error::Storage)?;

        work(&mut store).map_err(local_error)
    }
}

fn access(account: Uuid, space: Uuid) -> Access {
    let identity = SigningKey::from_bytes(&[3; 32]);
    let device = SigningKey::from_bytes(&[5; 32]);
    let public = device.verifying_key().to_bytes();
    let cert = c::certify(&identity, account, Uuid::new_v4(), public).unwrap();
    let mut access = Access {
        origin: String::new(),
        username: String::new(),
        token: String::new(),
        account,
        space,
        master: [1; 32],
        workspace: vec![],
        identity: identity.verifying_key().to_bytes(),
        device_key: device.to_bytes(),
        cert,
    };

    let keys = crate::account::extend_keyset(&[], &access.identity).unwrap();

    access.use_keyset(&keys).unwrap();

    access
}

fn page(space: Uuid, id: Uuid) -> Note {
    let doc = Doc::new();
    let body = doc.get_or_insert_text("body");

    body.insert(&mut doc.transact_mut(), 0, "nur für das andere Notizbuch");

    Note {
        id,
        space,
        kind: "page".into(),
        title: String::new(),
        body: String::new(),
        parent: None,
        archived: false,
        props: "{}".into(),
        links: Vec::new(),
        data: doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default()),
        rev: 0,
    }
}

fn device_with_foreign_page() -> (Device, Access, Access, Uuid, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("notebook.db"), &[9; 32]).unwrap();
    let account = Uuid::new_v4();
    let (here, there) = (
        access(account, Uuid::new_v4()),
        access(account, Uuid::new_v4()),
    );
    let id = Uuid::new_v4();

    store.save(&[page(there.space, id)], false).unwrap();

    (Device(Mutex::new(store)), here, there, id, dir)
}

#[test]
fn a_page_waiting_in_another_notebook_is_never_sealed_here() {
    let (local, here, _, id, _dir) = device_with_foreign_page();
    let keys = DocKeys::new(&here, id);
    let prepared = prepare_push(&local, &here, &keys, &Cursor::default(), WRITING).unwrap();

    assert!(prepared.is_none());
    assert!(local.with(|s| s.state(&keys.pending)).unwrap().is_none());
}

#[test]
fn a_pending_push_of_another_notebook_is_neither_resent_nor_acknowledged() {
    let (local, here, there, id, _dir) = device_with_foreign_page();
    let (note, rev) = local.with(|s| s.queued(id)).unwrap().unwrap();
    let bytes = p::encode(&kladde_store::wire_form(note)).unwrap();
    let request = Cursor::default()
        .push_as(&there, id, &bytes, WRITING)
        .unwrap();
    let foreign = p::encode(&Pending { rev, request }).unwrap();
    let keys = DocKeys::new(&here, id);

    local
        .with(|s| s.set_state(&keys.pending, &foreign))
        .unwrap();
    let prepared = prepare_push(&local, &here, &keys, &Cursor::default(), WRITING).unwrap();

    assert!(prepared.is_none());
    acknowledge(&local, &here, &keys, rev).unwrap();
    assert_eq!(local.with(|s| s.outbox(there.space)).unwrap(), vec![id]);
}

async fn relay_answering(replies: Vec<Server>) -> Socket {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();

    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();

        for reply in replies {
            let frame = p::packet(&reply).unwrap();

            ws.send(Message::Binary(frame.into())).await.unwrap();
        }

        while ws.next().await.is_some() {}
    });
    let url = format!("ws://{address}/");

    Socket(tokio_tungstenite::connect_async(url).await.unwrap().0)
}

#[tokio::test]
async fn a_pull_cut_short_still_reports_what_it_stored() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("notebook.db"), &[9; 32]).unwrap();
    let local = Device(Mutex::new(store));
    let a = access(Uuid::new_v4(), Uuid::new_v4());
    let id = Uuid::new_v4();
    let bytes = p::encode(&kladde_store::wire_form(page(a.space, id))).unwrap();
    let request = Cursor::default().push_as(&a, id, &bytes, WRITING).unwrap();
    let item = Server::Item {
        seq: 1,
        envelope: envelope(&request).unwrap().clone(),
        certificate: a.cert.clone(),
    };

    let mut socket = relay_answering(vec![item, Server::Conflict]).await;
    let keys = DocKeys::new(&a, id);
    let mut report = Report::default();
    let mut cursor = Cursor::default();
    let pulled = pull(&mut socket, &a, &local, &keys, &mut cursor, &mut report).await;

    assert!(matches!(pulled, Err(Error::Conflict)));
    assert!(local.with(|s| s.get(id)).unwrap().is_some());
    assert_eq!(report.changed, vec![id]);
}

fn shaped(space: Uuid, id: Uuid, kind: &str, parent: Option<Uuid>, doc: &Doc) -> Note {
    let mut note = page(space, id);

    note.kind = kind.into();
    note.parent = parent;
    note.data = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());

    note
}

fn registry_with(shard: Uuid) -> Doc {
    let doc = Doc::new();
    let registry = doc.get_or_insert_map("index");

    registry.insert(&mut doc.transact_mut(), shard.to_string(), "owner/0");

    doc
}

fn listing_with(page: Uuid) -> Doc {
    let doc = Doc::new();
    let pages = doc.get_or_insert_map("pages");
    let entry = Any::from(std::collections::HashMap::from([(
        "parent".to_string(),
        Any::Null,
    )]));

    pages.insert(&mut doc.transact_mut(), page.to_string(), entry);

    doc
}

fn signed_tombstone(signer: &SigningKey, device: Uuid, a: &Access, doc: Uuid) -> Tombstone {
    let message = purge_message(a.account, a.space, doc).unwrap();

    Tombstone {
        doc,
        device,
        proof: signer.sign(&message).to_bytes().to_vec(),
    }
}

fn relay_state(
    deleted: Vec<Uuid>,
    tombstones: Vec<Tombstone>,
    signers: Vec<Certificate>,
) -> SpaceState {
    SpaceState {
        docs: Vec::new(),
        deleted,
        tombstones,
        signers,
        checkpoints: true,
        mark: Some(1),
    }
}

#[test]
fn an_unsigned_relay_tombstone_dooms_no_page() {
    let a = access(Uuid::new_v4(), Uuid::new_v4());
    let doc = Uuid::new_v4();
    let state = relay_state(vec![doc], Vec::new(), Vec::new());

    assert!(signed_among(&a, &state, &[doc]).is_empty());
}

#[test]
fn a_tombstone_signed_by_a_device_of_the_current_identity_dooms_the_page() {
    let a = access(Uuid::new_v4(), Uuid::new_v4());
    let (doc, kept) = (Uuid::new_v4(), Uuid::new_v4());
    let signer = SigningKey::from_bytes(&a.device_key);
    let tombstone = signed_tombstone(&signer, a.cert.device, &a, doc);
    let state = relay_state(vec![doc, kept], vec![tombstone], vec![a.cert.clone()]);

    assert_eq!(signed_among(&a, &state, &[kept, doc]), vec![doc]);
}

#[test]
fn a_tombstone_from_a_device_of_an_earlier_identity_dooms_no_page() {
    let a = access(Uuid::new_v4(), Uuid::new_v4());
    let doc = Uuid::new_v4();
    let removed = SigningKey::from_bytes(&[6; 32]);
    let earlier = SigningKey::from_bytes(&[4; 32]);
    let public = removed.verifying_key().to_bytes();
    let cert = c::certify(&earlier, a.account, Uuid::new_v4(), public).unwrap();
    let tombstone = signed_tombstone(&removed, cert.device, &a, doc);
    let state = relay_state(vec![doc], vec![tombstone], vec![cert]);

    assert!(signed_among(&a, &state, &[doc]).is_empty());
}

#[test]
fn a_proof_for_another_page_or_from_an_unknown_signer_dooms_no_page() {
    let a = access(Uuid::new_v4(), Uuid::new_v4());
    let doc = Uuid::new_v4();
    let signer = SigningKey::from_bytes(&a.device_key);
    let mut moved = signed_tombstone(&signer, a.cert.device, &a, Uuid::new_v4());
    let stranger = signed_tombstone(&signer, Uuid::new_v4(), &a, doc);

    moved.doc = doc;
    let state = relay_state(vec![doc], vec![moved, stranger], vec![a.cert.clone()]);

    assert!(signed_among(&a, &state, &[doc]).is_empty());
}

#[test]
fn a_relay_tombstone_cannot_remove_a_registered_directory_or_its_pages() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("notebook.db"), &[9; 32]).unwrap();
    let a = access(Uuid::new_v4(), Uuid::new_v4());
    let (shard, listed) = (Uuid::new_v4(), Uuid::new_v4());

    store
        .save(
            &[
                shaped(a.space, a.space, "workspace", None, &registry_with(shard)),
                shaped(
                    a.space,
                    shard,
                    "index",
                    Some(a.space),
                    &listing_with(listed),
                ),
                page(a.space, listed),
            ],
            true,
        )
        .unwrap();
    let local = Device(Mutex::new(store));
    let mut report = Report::default();

    remove_deleted(&local, &a, vec![shard, listed], &mut report).unwrap();
    local
        .with(|store| {
            assert!(store.get(shard)?.is_some());
            assert!(store.get(listed)?.is_some());

            Ok(())
        })
        .unwrap();
    assert!(report.removed.is_empty());
    assert_eq!(report.rescue, vec![listed]);
}

#[tokio::test]
async fn an_update_that_cannot_be_merged_is_quarantined_instead_of_blocking_the_sync() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("notebook.db"), &[9; 32]).unwrap();
    let local = Device(Mutex::new(store));
    let a = access(Uuid::new_v4(), Uuid::new_v4());
    let id = Uuid::new_v4();
    let mut broken = page(a.space, id);

    broken.data = vec![0xFF];
    let bytes = p::encode(&broken).unwrap();
    let request = Cursor::default().push_as(&a, id, &bytes, WRITING).unwrap();
    let item = Server::Item {
        seq: 1,
        envelope: envelope(&request).unwrap().clone(),
        certificate: a.cert.clone(),
    };

    let head = Server::Head { doc: id, seq: 1 };
    let mut socket = relay_answering(vec![item, head]).await;
    let keys = DocKeys::new(&a, id);
    let mut report = Report::default();
    let mut cursor = Cursor::default();

    pull(&mut socket, &a, &local, &keys, &mut cursor, &mut report)
        .await
        .unwrap();
    assert_eq!(cursor.seq, 1);
    assert_eq!(report.damaged, vec![id]);
    assert_eq!(report.failed, vec![id]);
    assert!(local.with(|s| s.state(&keys.head)).unwrap().is_some());
    assert!(local.with(|s| s.get(id)).unwrap().is_none());
}
