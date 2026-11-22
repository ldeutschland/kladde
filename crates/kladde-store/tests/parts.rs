use kladde_store::{MAX_FILE_PARTS, Note, Record, Store};
use std::collections::HashMap;
use uuid::Uuid;
use yrs::{Any, Doc, Map, ReadTxn, StateVector, Transact};

fn listing(parts: Vec<Any>) -> Any {
    let fields = HashMap::from([
        ("name".to_string(), Any::from("Aufnahme.m4a")),
        ("parts".to_string(), Any::from(parts)),
    ]);

    Any::from(fields)
}

fn ids(parts: &[Uuid]) -> Vec<Any> {
    parts.iter().map(|id| Any::from(id.to_string())).collect()
}

fn page(space: Uuid, files: &[(Uuid, Any)]) -> Note {
    let doc = Doc::new();
    let map = doc.get_or_insert_map("files");

    for (id, meta) in files {
        map.insert(&mut doc.transact_mut(), id.to_string(), meta.clone());
    }

    Note {
        id: Uuid::new_v4(),
        space,
        kind: "page".into(),
        title: "Seite".into(),
        body: String::new(),
        parent: None,
        archived: false,
        props: "{}".into(),
        links: vec![],
        data: doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default()),
        rev: 0,
    }
}

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("notebook"), &[5; 32]).unwrap();

    (dir, store)
}

fn stored_file_ids(records: &[Record]) -> Vec<Uuid> {
    records
        .iter()
        .filter_map(|record| match record {
            Record::File { id, .. } => Some(*id),
            _ => None,
        })
        .collect()
}

#[test]
fn a_file_lists_its_parts_in_order() {
    let (_dir, mut store) = store();
    let space = Uuid::new_v4();
    let (whole, single) = (Uuid::new_v4(), Uuid::new_v4());
    let parts = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
    let note = page(
        space,
        &[(whole, listing(ids(&parts))), (single, Any::from("image"))],
    );

    store.save(std::slice::from_ref(&note), false).unwrap();
    assert_eq!(
        store.file_parts(space, note.id, whole).unwrap(),
        Some(parts.to_vec())
    );
    assert_eq!(store.file_parts(space, note.id, single).unwrap(), None);
    assert_eq!(
        store.file_parts(space, note.id, Uuid::new_v4()).unwrap(),
        None
    );
    assert!(store.file_parts(Uuid::new_v4(), note.id, whole).is_err());
}

#[test]
fn malformed_part_lists_are_rejected_but_do_not_stop_the_backup() {
    let (_dir, mut store) = store();
    let space = Uuid::new_v4();
    let repeated = Uuid::new_v4();
    let too_many: Vec<Any> = (0..=MAX_FILE_PARTS)
        .map(|_| Any::from(Uuid::new_v4().to_string()))
        .collect();
    let cases = [
        listing(vec![]),
        listing(vec![Any::from("not-an-id")]),
        listing(vec![Any::from(7.0)]),
        listing(ids(&[repeated, repeated])),
        listing(vec![Any::from(Uuid::nil().to_string())]),
        listing(too_many),
    ];

    for meta in cases {
        let file = Uuid::new_v4();
        let note = page(space, &[(file, meta)]);

        store.save(std::slice::from_ref(&note), false).unwrap();
        assert!(store.file_parts(space, note.id, file).is_err());
        assert_eq!(
            store.backup_bundle(space, note.id).unwrap().missing,
            vec![(note.id, file)]
        );
    }
}

#[test]
fn a_backup_carries_the_parts_and_asks_for_absent_ones() {
    let (_dir, mut store) = store();
    let space = Uuid::new_v4();
    let whole = Uuid::new_v4();
    let parts = [Uuid::new_v4(), Uuid::new_v4()];
    let note = page(space, &[(whole, listing(ids(&parts)))]);

    store.save(std::slice::from_ref(&note), false).unwrap();
    store
        .store_asset(space, note.id, parts[0], b"first part")
        .unwrap();
    let bundle = store.backup_bundle(space, note.id).unwrap();

    assert_eq!(stored_file_ids(&bundle.records), [parts[0]]);
    assert_eq!(bundle.missing, [(note.id, parts[1])]);
    store
        .store_asset(space, note.id, parts[1], b"second part")
        .unwrap();
    let bundle = store.backup_bundle(space, note.id).unwrap();
    let mut expected = parts.to_vec();

    expected.sort();
    assert_eq!(stored_file_ids(&bundle.records), expected);
    assert!(bundle.missing.is_empty());
}

#[test]
fn a_broken_file_entry_is_reported_missing_instead_of_failing_the_backup() {
    let (_dir, mut store) = store();
    let space = Uuid::new_v4();
    let broken = Uuid::new_v4();
    let mut note = page(space, &[(broken, Any::from("kaputt"))]);
    let doc = Doc::new();
    let files = doc.get_or_insert_map("files");

    files.insert(
        &mut doc.transact_mut(),
        broken.to_string(),
        listing(vec![Any::Null]),
    );
    files.insert(&mut doc.transact_mut(), "kein-uuid", listing(vec![]));
    note.data = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    store.save(&[note.clone()], false).unwrap();

    let bundle = store.backup_bundle(space, note.id).unwrap();

    assert_eq!(bundle.missing, vec![(note.id, broken)]);
}
