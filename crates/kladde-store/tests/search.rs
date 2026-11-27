use kladde_store::{Note, SearchHit, Store};
use std::{collections::HashMap, path::Path};
use uuid::Uuid;
use yrs::{Any, Doc, Map, ReadTxn, StateVector, Transact};

const KEY: [u8; 32] = [5; 32];
const FILLER: &str = "Absatz mit Fülltext ";

fn page_with_file(space: Uuid, body: &str, file: Uuid, name: &str, links: Vec<Uuid>) -> Note {
    let doc = Doc::new();
    let files = doc.get_or_insert_map("files");
    let meta = HashMap::from([("name".to_owned(), Any::from(name))]);

    files.insert(&mut doc.transact_mut(), file.to_string(), Any::from(meta));

    Note {
        id: Uuid::new_v4(),
        space,
        kind: "page".into(),
        title: "Hausakte".into(),
        body: body.into(),
        parent: None,
        archived: false,
        props: "{}".into(),
        links,
        data: doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default()),
        rev: 0,
    }
}

fn hits(store: &Store, space: Uuid, query: &str) -> Vec<SearchHit> {
    store.search_content(space, query, None).unwrap()
}

fn opened_raw(path: &Path) -> rusqlite::Connection {
    let raw = rusqlite::Connection::open(path).unwrap();
    let key = format!("PRAGMA key=\"x'{}'\"", hex::encode(KEY));

    raw.execute_batch(&key).unwrap();

    raw
}

fn as_older_index(path: &Path) {
    opened_raw(path)
        .execute_batch(
            "DELETE FROM words; INSERT INTO words SELECT id,space,title,body FROM notes; PRAGMA user_version=5;",
        )
        .unwrap();
}

fn as_version_six(path: &Path) {
    opened_raw(path)
        .execute_batch("PRAGMA user_version=6;")
        .unwrap();
}

#[test]
fn excerpts_read_like_text_while_the_body_keeps_links_and_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notebook");
    let mut store = Store::open(&path, &KEY).unwrap();
    let (space, file, target) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let body = format!(
        "Wartungsvertrag läuft bis Ende 2027. Siehe [Heizung](kladde:{target}).\n\n<audio src=\"kladde-file:{file}\"></audio>"
    );
    let page = page_with_file(space, &body, file, "Scan.png", vec![target]);

    store.save(std::slice::from_ref(&page), false).unwrap();

    let found = hits(&store, space, "Wartungsvertrag");

    assert_eq!(found.len(), 1);
    assert_eq!(
        found[0].snippet,
        "Wartungsvertrag läuft bis Ende 2027. Siehe Heizung."
    );

    for markup in ["kladde", "audio", "src", &file.to_string()[..8]] {
        assert!(hits(&store, space, markup).is_empty(), "{markup}");
    }

    assert_eq!(store.get(page.id).unwrap().unwrap().body, body);
    assert_eq!(store.backlinks(target).unwrap(), [page.id]);

    let job = store.next_attachment().unwrap().unwrap();
    let scanned = format!(
        "{}Rechnung Nr. 4711\nBetrag:\n120 Euro\n\u{c}{}",
        FILLER.repeat(8),
        FILLER.repeat(12)
    );

    store.finish_attachment(&job, "ready", &scanned).unwrap();
    let found = hits(&store, space, "Betrag");

    assert_eq!(found.len(), 1);
    let excerpt = &found[0].snippet;

    assert!(
        excerpt.starts_with("… Absatz") && excerpt.ends_with(" …"),
        "{excerpt}"
    );
    assert!(
        excerpt.contains("Rechnung Nr. 4711 Betrag: 120 Euro Absatz"),
        "{excerpt}"
    );
    assert!(!excerpt.contains(['\n', '\u{c}']));
    assert_eq!(found[0].matched, "Betrag");
    assert_eq!(found[0].page, 0);

    let named = hits(&store, space, "Scan");

    assert_eq!(named.len(), 1);
    assert_eq!(named[0].file, Some(file.to_string()));
    assert_eq!(named[0].snippet, "");

    drop(store);
    as_older_index(&path);
    let store = Store::open(&path, &KEY).unwrap();

    assert!(hits(&store, space, "kladde").is_empty());
    assert_eq!(hits(&store, space, "Heizung").len(), 1);
}

#[test]
fn media_an_older_app_skipped_is_queued_once_more() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notebook");
    let mut store = Store::open(&path, &KEY).unwrap();
    let (space, file) = (Uuid::new_v4(), Uuid::new_v4());
    let body = format!("<audio src=\"kladde-file:{file}\"></audio>");
    let page = page_with_file(space, &body, file, "Memo.m4a", vec![]);

    store.save(&[page], false).unwrap();
    let skipped = store.next_attachment().unwrap().unwrap();

    store
        .finish_attachment(&skipped, "unsupported", "")
        .unwrap();
    assert!(store.next_attachment().unwrap().is_none());
    drop(store);
    as_version_six(&path);
    let mut store = Store::open(&path, &KEY).unwrap();
    let again = store.next_attachment().unwrap().unwrap();

    assert_eq!(again.file, file);
    store.finish_attachment(&again, "unsupported", "").unwrap();
    drop(store);
    let store = Store::open(&path, &KEY).unwrap();

    assert!(store.next_attachment().unwrap().is_none());
}

#[test]
fn the_whole_recognized_text_of_a_file_is_read_for_finding_in_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("notebook"), &KEY).unwrap();
    let (space, file) = (Uuid::new_v4(), Uuid::new_v4());
    let body = format!("[Scan](kladde-file:{file})");
    let page = page_with_file(space, &body, file, "Scan.pdf", vec![]);

    store.save(std::slice::from_ref(&page), false).unwrap();
    assert!(
        store
            .attachment_words(space, page.id, file)
            .unwrap()
            .is_none()
    );
    let job = store.next_attachment().unwrap().unwrap();
    let text = format!("{}\u{c}Betrag: 120 Euro", FILLER.repeat(600));

    store.finish_attachment(&job, "partial", &text).unwrap();
    let found = store
        .attachment_words(space, page.id, file)
        .unwrap()
        .unwrap();

    assert_eq!((found.doc, found.file), (page.id, file));
    assert_eq!(found.status, "partial");
    assert_eq!(found.text, text);
    assert!(
        store
            .attachment_words(Uuid::new_v4(), page.id, file)
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .attachment_words(space, page.id, Uuid::new_v4())
            .unwrap()
            .is_none()
    );
}

#[test]
fn a_file_without_readable_text_offers_nothing_to_find_in() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("notebook"), &KEY).unwrap();
    let (space, file) = (Uuid::new_v4(), Uuid::new_v4());
    let body = format!("[Scan](kladde-file:{file})");
    let page = page_with_file(space, &body, file, "Kaputt.pdf", vec![]);

    store.save(std::slice::from_ref(&page), false).unwrap();
    let job = store.next_attachment().unwrap().unwrap();

    store.finish_attachment(&job, "unreadable", "").unwrap();
    assert!(
        store
            .attachment_words(space, page.id, file)
            .unwrap()
            .is_none()
    );
}
