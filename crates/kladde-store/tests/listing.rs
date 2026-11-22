use kladde_store::{Incoming, Note, Store};
use std::{collections::HashMap, sync::Arc};
use uuid::Uuid;
use yrs::{Any, Doc, Map, ReadTxn, StateVector, Transact, Update};

fn open() -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("notebook"), &[7; 32]).unwrap();

    (store, dir)
}

fn state_of(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn note(space: Uuid, id: Uuid, kind: &str, doc: &Doc, rev: i64) -> Note {
    Note {
        id,
        space,
        kind: kind.into(),
        title: "Titel".into(),
        body: "Inhalt".into(),
        parent: None,
        archived: false,
        props: "{}".into(),
        links: vec![],
        data: state_of(doc),
        rev,
    }
}

fn entry(parent: Option<Uuid>, archived: Option<i64>) -> Any {
    let mut page = HashMap::new();

    page.insert(
        "parent".to_string(),
        parent.map_or(Any::Null, |p| Any::from(p.to_string())),
    );
    page.insert(
        "archived".to_string(),
        archived.map_or(Any::Null, |at| Any::from(at as f64)),
    );

    Any::Map(Arc::new(page))
}

fn list(doc: &Doc, id: Uuid, parent: Option<Uuid>, archived: Option<i64>) {
    let pages = doc.get_or_insert_map("pages");

    pages.insert(
        &mut doc.transact_mut(),
        id.to_string(),
        entry(parent, archived),
    );
}

fn loaded(store: &Store, id: Uuid) -> (Doc, i64) {
    let stored = store.get(id).unwrap().unwrap();
    let doc = Doc::new();

    doc.transact_mut()
        .apply_update(Update::decode_complete_v1(&stored.data).unwrap())
        .unwrap();
    (doc, stored.rev)
}

fn page_doc(text: &str) -> Doc {
    let doc = Doc::new();
    let meta = doc.get_or_insert_map("meta");

    meta.insert(&mut doc.transact_mut(), "text", text);

    doc
}

#[test]
fn the_manifest_decides_where_a_merged_page_lives() {
    let (mut store, _dir) = open();
    let (space, page, folder) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let manifest = Doc::new();

    list(&manifest, page, Some(folder), Some(1700000000000));
    list(&manifest, folder, None, None);
    store
        .save(&[note(space, space, "workspace", &manifest, 0)], false)
        .unwrap();
    let local = page_doc("alt");

    store
        .save(&[note(space, page, "page", &local, 0)], false)
        .unwrap();
    assert!(!store.get(page).unwrap().unwrap().archived);

    let remote = page_doc("neu");
    let mut incoming = Incoming::default();

    incoming.add(note(space, page, "page", &remote, 0)).unwrap();
    assert!(store.merge_all(incoming, "head:p", &[1]).unwrap());
    let merged = store.get(page).unwrap().unwrap();

    assert!(merged.archived, "manifest says trashed");
    assert_eq!(merged.parent, Some(folder));
    assert!(!store.search(space, "Titel").unwrap().contains(&page));
}

#[test]
fn a_merged_manifest_moves_and_trashes_stored_pages() {
    let (mut store, _dir) = open();
    let (space, page, folder) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let manifest = Doc::new();

    list(&manifest, page, None, None);
    list(&manifest, folder, None, None);
    store
        .save(&[note(space, space, "workspace", &manifest, 0)], false)
        .unwrap();
    store
        .save(&[note(space, page, "page", &page_doc("eins"), 0)], false)
        .unwrap();
    store
        .save(&[note(space, folder, "page", &page_doc("zwei"), 0)], false)
        .unwrap();
    let before = store.get(page).unwrap().unwrap();

    let (remote, _) = loaded(&store, space);

    list(&remote, page, Some(folder), Some(5));
    let mut incoming = Incoming::default();

    incoming
        .add(note(space, space, "workspace", &remote, 0))
        .unwrap();
    assert!(store.merge_all(incoming, "head:m", &[1]).unwrap());
    let after = store.get(page).unwrap().unwrap();

    assert_eq!(after.parent, Some(folder));
    assert!(after.archived);
    assert_eq!(
        after.rev, before.rev,
        "placement does not bump the revision"
    );
    assert!(!store.search(space, "Inhalt").unwrap().contains(&page));

    let (restored, _) = loaded(&store, space);

    list(&restored, page, None, None);
    let mut incoming = Incoming::default();

    incoming
        .add(note(space, space, "workspace", &restored, 0))
        .unwrap();
    assert!(store.merge_all(incoming, "head:m", &[2]).unwrap());
    let back = store.get(page).unwrap().unwrap();

    assert_eq!(back.parent, None);
    assert!(!back.archived);
    assert!(store.search(space, "Inhalt").unwrap().contains(&page));
}

#[test]
fn only_trashed_or_unlisted_pages_can_be_forgotten() {
    let (mut store, _dir) = open();
    let (space, listed, unlisted) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let manifest = Doc::new();

    list(&manifest, listed, None, None);
    store
        .save(&[note(space, space, "workspace", &manifest, 0)], false)
        .unwrap();
    for id in [listed, unlisted] {
        store
            .save(&[note(space, id, "page", &page_doc("x"), 0)], false)
            .unwrap();
    }

    assert!(store.forget(listed).is_err());
    assert!(store.get(listed).unwrap().is_some());
    store.forget(unlisted).unwrap();
    assert!(store.get(unlisted).unwrap().is_none());
    assert_eq!(store.deletions(space).unwrap(), vec![unlisted]);
    assert!(store.forget(space).is_err());
}

#[test]
fn files_wait_for_the_confirmed_deletion_and_come_back_on_revival() {
    let (mut store, _dir) = open();
    let (space, page, file) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());

    store
        .save(&[note(space, space, "workspace", &Doc::new(), 0)], false)
        .unwrap();
    store
        .save(&[note(space, page, "page", &page_doc("x"), 0)], false)
        .unwrap();
    store.store_asset(space, page, file, &[1, 2, 3]).unwrap();
    store.forget(page).unwrap();
    assert!(store.erased_files(space).unwrap().is_empty(), "held back");
    store.deleted(page).unwrap();
    assert_eq!(store.erased_files(space).unwrap(), vec![file]);
    store.file_erased(space, file).unwrap();
    assert!(store.erased_files(space).unwrap().is_empty());

    let (other, attachment) = (Uuid::new_v4(), Uuid::new_v4());

    store
        .save(&[note(space, other, "page", &page_doc("y"), 0)], false)
        .unwrap();
    store.store_asset(space, other, attachment, &[4]).unwrap();
    store.forget(other).unwrap();
    store.revive(space, other).unwrap();
    assert!(store.deletions(space).unwrap().is_empty());
    assert!(store.erased_files(space).unwrap().is_empty());
    store
        .save(&[note(space, other, "page", &page_doc("y"), 0)], false)
        .unwrap();
}

fn directory(space: Uuid, id: Uuid, owner: Uuid, doc: &Doc, rev: i64) -> Note {
    let mut shard = note(space, id, "index", doc, rev);

    shard.title = String::new();
    shard.body = String::new();
    shard.parent = Some(owner);

    shard
}

fn list_at(doc: &Doc, id: Uuid, parent: Option<Uuid>, updated: i64) {
    let mut page = HashMap::new();

    page.insert(
        "parent".to_string(),
        parent.map_or(Any::Null, |p| Any::from(p.to_string())),
    );
    page.insert("archived".to_string(), Any::Null);
    page.insert("updated".to_string(), Any::from(updated as f64));
    let pages = doc.get_or_insert_map("pages");

    pages.insert(
        &mut doc.transact_mut(),
        id.to_string(),
        Any::Map(Arc::new(page)),
    );
}

#[test]
fn pages_listed_in_a_directory_document_are_placed_and_protected() {
    let (mut store, _dir) = open();
    let (space, page, folder, shard) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );

    store
        .save(&[note(space, space, "workspace", &Doc::new(), 0)], false)
        .unwrap();
    store
        .save(&[note(space, page, "page", &page_doc("x"), 0)], false)
        .unwrap();
    let listing = Doc::new();

    list(&listing, page, Some(folder), None);
    store
        .save(&[directory(space, shard, space, &listing, 0)], false)
        .unwrap();
    assert!(store.is_listed(space, page).unwrap());
    assert_eq!(store.get(page).unwrap().unwrap().parent, Some(folder));
    assert!(store.forget(page).is_err());
    assert_eq!(store.listings(space).unwrap(), vec![shard]);
    assert!(store.listing_waits(space).unwrap());

    let (emptied, rev) = loaded(&store, shard);
    let pages = emptied.get_or_insert_map("pages");

    pages.remove(&mut emptied.transact_mut(), &page.to_string());
    store
        .save(&[directory(space, shard, space, &emptied, rev)], false)
        .unwrap();
    assert!(!store.is_listed(space, page).unwrap());
    store.forget(page).unwrap();
}

#[test]
fn the_newer_entry_wins_when_two_directories_list_a_page() {
    let (mut store, _dir) = open();
    let (space, page) = (Uuid::new_v4(), Uuid::new_v4());
    let (old_home, new_home) = (Uuid::new_v4(), Uuid::new_v4());

    store
        .save(&[note(space, space, "workspace", &Doc::new(), 0)], false)
        .unwrap();
    store
        .save(&[note(space, page, "page", &page_doc("x"), 0)], false)
        .unwrap();
    let (older, newer) = (Doc::new(), Doc::new());

    list_at(&older, page, Some(old_home), 100);
    list_at(&newer, page, Some(new_home), 200);

    for (doc, shard) in [(&newer, Uuid::new_v4()), (&older, Uuid::new_v4())] {
        store
            .save(&[directory(space, shard, space, doc, 0)], false)
            .unwrap();
    }

    assert_eq!(store.get(page).unwrap().unwrap().parent, Some(new_home));
}

fn database_with_rows(store: &mut Store, space: Uuid) -> (Uuid, Vec<Uuid>, Uuid, Uuid) {
    let (database, shard, file) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let rows: Vec<Uuid> = (0..50).map(|_| Uuid::new_v4()).collect();

    store
        .save(&[note(space, space, "workspace", &Doc::new(), 0)], false)
        .unwrap();
    store
        .save(
            &[note(space, database, "database", &page_doc("x"), 0)],
            false,
        )
        .unwrap();
    for row in &rows {
        let mut stored = note(space, *row, "row", &page_doc("Zeile"), 0);

        stored.parent = Some(database);
        store.save(&[stored], false).unwrap();
    }

    store
        .save(&[directory(space, shard, database, &Doc::new(), 0)], false)
        .unwrap();
    store.store_asset(space, rows[0], file, &[1, 2, 3]).unwrap();

    (database, rows, shard, file)
}

#[test]
fn forgetting_a_database_removes_its_rows_and_directories_at_once() {
    let (mut store, _dir) = open();
    let space = Uuid::new_v4();
    let (database, rows, shard, file) = database_with_rows(&mut store, space);

    store.forget(database).unwrap();
    assert!(store.get(rows[7]).unwrap().is_none());
    assert!(store.get(shard).unwrap().is_none());
    assert_eq!(store.deletions(space).unwrap(), vec![database]);
    assert!(store.discards(space).unwrap().is_none(), "wait");
    assert!(store.erased_files(space).unwrap().is_empty());
    store.deleted(database).unwrap();
    let (owner, discards) = store.discards(space).unwrap().unwrap();

    assert_eq!(owner, database);
    assert_eq!(discards.len(), rows.len() + 1);
    assert_eq!(store.erased_files(space).unwrap(), vec![file]);
    store.discarded(&discards).unwrap();
    assert!(store.discards(space).unwrap().is_none());
}

#[test]
fn a_database_deleted_elsewhere_takes_its_rows_along() {
    let (mut store, _dir) = open();
    let space = Uuid::new_v4();
    let (database, rows, shard, _) = database_with_rows(&mut store, space);

    assert!(store.rows_waiting(database).unwrap());
    assert!(store.drop_synced(space, database).unwrap());
    assert!(store.get(rows[0]).unwrap().is_none());
    assert!(store.get(shard).unwrap().is_none());
    assert!(store.discards(space).unwrap().is_none());
    assert!(store.search(space, "Zeile").unwrap().is_empty());
}

#[test]
fn a_deletion_from_another_notebook_leaves_the_database_alone() {
    let (mut store, _dir) = open();
    let (own, foreign) = (Uuid::new_v4(), Uuid::new_v4());
    let (database, rows, shard, _) = database_with_rows(&mut store, own);

    store
        .save(
            &[note(foreign, foreign, "workspace", &Doc::new(), 0)],
            false,
        )
        .unwrap();
    assert!(!store.drop_synced(foreign, database).unwrap());
    assert!(store.get(database).unwrap().is_some());
    assert!(store.get(shard).unwrap().is_some());
    let mut edited = store.get(rows[0]).unwrap().unwrap();

    edited.title = "weiter bearbeitbar".into();
    store.save(&[edited], false).unwrap();
}

#[test]
fn an_older_notebook_gets_its_listing_on_first_open() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notebook");
    let (space, page) = (Uuid::new_v4(), Uuid::new_v4());
    let manifest = Doc::new();

    list(&manifest, page, None, Some(9));
    let mut store = Store::open(&path, &[7; 32]).unwrap();

    store
        .save(&[note(space, space, "workspace", &manifest, 0)], false)
        .unwrap();
    store
        .save(&[note(space, page, "page", &page_doc("x"), 0)], false)
        .unwrap();
    drop(store);
    let raw = rusqlite::Connection::open(&path).unwrap();
    let key = format!("PRAGMA key=\"x'{}'\"", "07".repeat(32));

    raw.execute_batch(&key).unwrap();
    raw.execute_batch("DELETE FROM listing; UPDATE notes SET archived=0; PRAGMA user_version=3;")
        .unwrap();
    drop(raw);
    let store = Store::open(&path, &[7; 32]).unwrap();

    assert!(store.is_listed(space, page).unwrap());
    assert!(store.get(page).unwrap().unwrap().archived);
}

#[test]
fn a_directory_cannot_place_a_page_of_another_notebook() {
    let (mut store, _dir) = open();
    let (own, foreign, page, shard) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );

    for space in [own, foreign] {
        store
            .save(&[note(space, space, "workspace", &Doc::new(), 0)], false)
            .unwrap();
    }

    store
        .save(&[note(own, page, "page", &page_doc("x"), 0)], false)
        .unwrap();
    let hostile = Doc::new();

    list(&hostile, page, Some(Uuid::new_v4()), Some(7));
    store
        .save(&[directory(foreign, shard, foreign, &hostile, 0)], false)
        .unwrap();
    let untouched = store.get(page).unwrap().unwrap();

    assert!(!untouched.archived);
    assert_eq!(untouched.parent, None);
    assert!(!store.is_listed(own, page).unwrap());
}

fn register(doc: &Doc, shard: Uuid) {
    let registry = doc.get_or_insert_map("index");

    registry.insert(&mut doc.transact_mut(), shard.to_string(), "owner/0");
}

#[test]
fn a_directory_counts_as_registered_while_a_manifest_or_directory_names_it() {
    let (mut store, _dir) = open();
    let (space, shard, nested, stray) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let manifest = Doc::new();

    register(&manifest, shard);
    store
        .save(&[note(space, space, "workspace", &manifest, 0)], false)
        .unwrap();
    let host = Doc::new();

    register(&host, nested);
    store
        .save(&[directory(space, shard, space, &host, 0)], false)
        .unwrap();
    assert!(store.is_registered(space, shard).unwrap());
    assert!(store.is_registered(space, nested).unwrap());
    assert!(!store.is_registered(space, stray).unwrap());
    assert!(!store.is_registered(Uuid::new_v4(), shard).unwrap());

    let (emptied, rev) = loaded(&store, space);
    let registry = emptied.get_or_insert_map("index");

    registry.remove(&mut emptied.transact_mut(), &shard.to_string());
    store
        .save(&[note(space, space, "workspace", &emptied, rev)], false)
        .unwrap();
    assert!(!store.is_registered(space, shard).unwrap());
}
