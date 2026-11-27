use kladde_store::{Incoming, Note, Store, wire_form};
use uuid::Uuid;
use yrs::{Any, Doc, Map, MapPrelim, Out, ReadTxn, StateVector, Text, Transact};

const CURSOR_KEY: &str = "head:test";

fn open() -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("notebook"), &[7; 32]).unwrap();

    (store, dir)
}

fn page(id: Uuid, space: Uuid, doc: &Doc) -> Note {
    let meta = doc.get_or_insert_map("meta");
    let text = match meta.get(&doc.transact(), "text") {
        Some(Out::Any(Any::String(text))) => text.to_string(),
        _ => String::new(),
    };

    Note {
        id,
        space,
        kind: "page".into(),
        title: "Probe".into(),
        body: text,
        parent: None,
        archived: false,
        props: r#"{"status":"offen"}"#.into(),
        links: vec![],
        data: doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default()),
        rev: 0,
    }
}

fn written(text: &str) -> Doc {
    let doc = Doc::new();
    let meta = doc.get_or_insert_map("meta");
    let properties = doc.get_or_insert_map("properties");
    let mut txn = doc.transact_mut();

    meta.insert(&mut txn, "title", "Probe");
    meta.insert(&mut txn, "text", text);
    properties.insert(&mut txn, "status", "offen");
    drop(txn);

    doc
}

fn incoming(notes: impl IntoIterator<Item = Note>) -> Incoming {
    let mut incoming = Incoming::default();

    for note in notes {
        incoming.add(note).unwrap();
    }

    incoming
}

#[test]
fn known_content_only_moves_the_cursor() {
    let (mut store, _dir) = open();
    let (id, space) = (Uuid::new_v4(), Uuid::new_v4());
    let doc = written("bekannt");

    store.save(&[page(id, space, &doc)], true).unwrap();
    let before = store.get(id).unwrap().unwrap();
    let changed = store
        .merge_all(incoming([page(id, space, &doc)]), CURSOR_KEY, b"cursor")
        .unwrap();
    assert!(!changed);
    assert_eq!(store.get(id).unwrap().unwrap(), before);
    assert_eq!(store.versions(id).unwrap().len(), 0);
    assert_eq!(store.state(CURSOR_KEY).unwrap().unwrap(), b"cursor");
}

#[test]
fn several_envelopes_are_written_once() {
    let (mut store, _dir) = open();
    let (id, space) = (Uuid::new_v4(), Uuid::new_v4());
    let local = written("lokal");

    store.save(&[page(id, space, &local)], true).unwrap();
    let first = written("erstes");
    let second = written("zweites");
    let changed = store
        .merge_all(
            incoming([page(id, space, &first), page(id, space, &second)]),
            CURSOR_KEY,
            b"cursor",
        )
        .unwrap();
    assert!(changed);
    let merged = store.get(id).unwrap().unwrap();

    assert_eq!(merged.rev, 2);
    assert_eq!(store.versions(id).unwrap().len(), 1);
    let doc = Doc::new();

    doc.transact_mut()
        .apply_update(yrs::Update::decode_complete_v1(&merged.data).unwrap())
        .unwrap();
    assert!(doc.transact().state_vector().len() >= 3);
    assert_eq!(store.state(CURSOR_KEY).unwrap().unwrap(), b"cursor");
}

#[test]
fn moving_a_page_counts_as_a_change() {
    let (mut store, _dir) = open();
    let (id, space) = (Uuid::new_v4(), Uuid::new_v4());
    let doc = written("bleibt");

    store.save(&[page(id, space, &doc)], true).unwrap();
    let mut moved = page(id, space, &doc);

    moved.parent = Some(Uuid::new_v4());
    assert!(
        store
            .merge_all(incoming([moved]), CURSOR_KEY, b"c")
            .unwrap()
    );
}

#[test]
fn envelopes_of_different_documents_are_refused() {
    let space = Uuid::new_v4();
    let doc = written("x");
    let mut mixed = Incoming::default();

    mixed.add(page(Uuid::new_v4(), space, &doc)).unwrap();
    assert!(mixed.add(page(Uuid::new_v4(), space, &doc)).is_err());
    let (mut store, _dir) = open();

    assert!(
        store
            .merge_all(Incoming::default(), CURSOR_KEY, b"c")
            .is_err()
    );
}

#[test]
fn the_wire_form_drops_only_what_the_receiver_derives() {
    let (mut store, _dir) = open();
    let (id, space) = (Uuid::new_v4(), Uuid::new_v4());
    let doc = written("Text mit kladde:00000000-0000-4000-8000-000000000001");
    let original = page(id, space, &doc);
    let wire = wire_form(original.clone());

    assert_eq!(wire.body, "");
    assert_eq!(wire.props, "{}");
    assert!(wire.links.is_empty());
    assert_eq!(wire.data, original.data);
    assert!(store.merge_all(incoming([wire]), CURSOR_KEY, b"c").unwrap());
    let received = store.get(id).unwrap().unwrap();

    assert_eq!(received.body, original.body);
    assert_eq!(received.props, original.props);
    assert_eq!(received.links.len(), 1);
}

#[test]
fn a_body_without_matching_text_is_kept() {
    let id = Uuid::new_v4();
    let mut note = page(id, Uuid::new_v4(), &written("im Dokument"));

    note.body = "nur im Eintrag".into();
    assert_eq!(wire_form(note).body, "nur im Eintrag");
    let mut broken = page(id, Uuid::new_v4(), &written("x"));

    broken.data = vec![1, 2, 3];
    broken.body = "bleibt".into();
    assert_eq!(wire_form(broken).body, "bleibt");
}

fn nested(levels: usize) -> Doc {
    let doc = Doc::new();
    let properties = doc.get_or_insert_map("properties");
    let mut txn = doc.transact_mut();
    let mut current = properties.insert(&mut txn, "x", MapPrelim::default());

    for _ in 1..levels {
        current = current.insert(&mut txn, "x", MapPrelim::default());
    }

    drop(txn);

    doc
}

#[test]
fn shared_types_nested_too_deeply_are_refused_before_recursive_code_runs() {
    let (mut store, _dir) = open();
    let (id, space) = (Uuid::new_v4(), Uuid::new_v4());
    let mut refused = Incoming::default();

    assert!(refused.add(page(id, space, &nested(300))).is_err());

    let accepted = incoming([page(id, space, &nested(100))]);

    assert!(store.merge_all(accepted, CURSOR_KEY, b"1").unwrap());
}

fn filled(letter: &str, length: usize) -> Doc {
    let doc = Doc::new();
    let draft = doc.get_or_insert_text("draft");

    draft.insert(&mut doc.transact_mut(), 0, &letter.repeat(length));

    doc
}

#[test]
fn an_envelope_the_store_could_never_keep_is_refused_on_arrival() {
    let (id, space) = (Uuid::new_v4(), Uuid::new_v4());
    let mut oversized = Incoming::default();

    assert!(
        oversized
            .add(page(id, space, &filled("x", 4_200_000)))
            .is_err()
    );
    assert!(oversized.is_empty());
}

#[test]
fn only_envelopes_of_the_stored_page_join_it() {
    let (mut store, _dir) = open();
    let (id, space) = (Uuid::new_v4(), Uuid::new_v4());
    let doc = written("x");
    let mut row = page(id, space, &doc);

    store.save(&[page(id, space, &doc)], true).unwrap();
    let mut continuing = store.incoming(id).unwrap();

    row.kind = "row".into();
    assert!(continuing.add(row).is_err());
    assert!(continuing.add(page(id, Uuid::new_v4(), &doc)).is_err());
    assert!(continuing.is_empty());
    continuing.add(page(id, space, &doc)).unwrap();
    assert!(!continuing.is_empty());
}

#[test]
fn an_envelope_that_would_outgrow_the_page_is_left_out_and_the_rest_kept() {
    let (mut store, _dir) = open();
    let (id, space) = (Uuid::new_v4(), Uuid::new_v4());
    let mut halves = store.incoming(id).unwrap();

    halves
        .add(page(id, space, &filled("a", 2_500_000)))
        .unwrap();
    assert!(
        halves
            .add(page(id, space, &filled("b", 2_500_000)))
            .is_err()
    );
    halves.add(page(id, space, &written("klein"))).unwrap();
    assert!(store.merge_all(halves, CURSOR_KEY, b"c").unwrap());
    let kept = store.get(id).unwrap().unwrap();

    assert!(kept.data.len() < 3_000_000);
    assert_eq!(kept.body, "klein");
    assert_eq!(store.state(CURSOR_KEY).unwrap().unwrap(), b"c");
}

#[test]
fn what_the_device_already_stored_counts_against_an_envelope() {
    let (mut store, _dir) = open();
    let (id, space) = (Uuid::new_v4(), Uuid::new_v4());

    store
        .save(&[page(id, space, &filled("a", 2_500_000))], true)
        .unwrap();
    let mut continuing = store.incoming(id).unwrap();

    assert!(
        continuing
            .add(page(id, space, &filled("b", 2_500_000)))
            .is_err()
    );
    assert!(continuing.is_empty());
    continuing.add(page(id, space, &written("klein"))).unwrap();
}
