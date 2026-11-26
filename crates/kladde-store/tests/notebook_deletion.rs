use kladde_store::{AttachmentJob, Error, Note, Store};
use rusqlite::Connection;
use std::collections::HashMap;
use tempfile::TempDir;
use uuid::Uuid;
use yrs::{Any, Doc, Map, ReadTxn, StateVector, Transact};

const KEY: [u8; 32] = [3; 32];
const DATABASE_FILE: &str = "notebook";
const FILE_NAME: &str = "Vertrag.pdf";
const FILE_TEXT: &str = "Rechnung Betrag 4711\u{c}Seite zwei";
const WORD: &str = "Rechnung";
const WORKSPACE: &str = "workspace";
const SPACE_ROWS: [&str; 9] = [
    "SELECT count(*) FROM notes WHERE space=?1",
    "SELECT count(*) FROM words WHERE space=?1",
    "SELECT count(*) FROM listing WHERE space=?1",
    "SELECT count(*) FROM file_owners WHERE space=?1",
    "SELECT count(*) FROM page_artwork WHERE space=?1",
    "SELECT count(*) FROM deletions WHERE space=?1",
    "SELECT count(*) FROM discards WHERE space=?1",
    "SELECT count(*) FROM erased_files WHERE space=?1",
    "SELECT count(*) FROM erased_texts WHERE space=?1",
];
const ORPHANS: [&str; 6] = [
    "SELECT count(*) FROM versions WHERE id NOT IN (SELECT id FROM notes)",
    "SELECT count(*) FROM outbox WHERE id NOT IN (SELECT id FROM notes)",
    "SELECT count(*) FROM page_files WHERE doc NOT IN (SELECT id FROM notes)",
    "SELECT count(*) FROM file_words WHERE rowid NOT IN (SELECT rowid FROM page_files)",
    "SELECT count(*) FROM erased_file_docs WHERE file NOT IN (SELECT id FROM erased_files)",
    "SELECT count(*) FROM row_marks WHERE id NOT IN (SELECT id FROM notes) AND parent NOT IN (SELECT id FROM notes)",
];

struct Book {
    space: Uuid,
    page: Uuid,
    file: Uuid,
    erased: Uuid,
}

fn data_of(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn note(space: Uuid, id: Uuid, kind: &str) -> Note {
    Note {
        id,
        space,
        kind: kind.into(),
        title: kind.into(),
        body: String::new(),
        parent: None,
        archived: false,
        props: "{}".into(),
        links: vec![],
        data: data_of(&Doc::new()),
        rev: 0,
    }
}

fn manifest(space: Uuid, page: Uuid, icon: Uuid) -> Note {
    let doc = Doc::new();
    let pages = doc.get_or_insert_map("pages");
    let entry = HashMap::from([("icon".to_owned(), Any::from(format!("kladde-file:{icon}")))]);

    pages.insert(&mut doc.transact_mut(), page.to_string(), Any::from(entry));

    Note {
        data: data_of(&doc),
        ..note(space, space, WORKSPACE)
    }
}

fn page_with_file(space: Uuid, file: Uuid) -> Note {
    let doc = Doc::new();
    let files = doc.get_or_insert_map("files");
    let meta = HashMap::from([("name".to_owned(), Any::from(FILE_NAME))]);

    files.insert(&mut doc.transact_mut(), file.to_string(), Any::from(meta));

    Note {
        body: format!("{WORD} kladde-file:{file}"),
        data: data_of(&doc),
        ..note(space, Uuid::new_v4(), "page")
    }
}

fn trashed(note: Note) -> Note {
    Note {
        archived: true,
        ..note
    }
}

fn leave_tombstones(store: &mut Store, space: Uuid) -> Uuid {
    let erased = trashed(page_with_file(space, Uuid::new_v4()));
    let database = trashed(note(space, Uuid::new_v4(), "database"));
    let row = Note {
        parent: Some(database.id),
        ..note(space, Uuid::new_v4(), "row")
    };

    store
        .save(&[erased.clone(), database.clone(), row], false)
        .unwrap();
    store.forget(erased.id).unwrap();
    store.forget(database.id).unwrap();

    erased.id
}

fn sync_states(account: Uuid, book: &Book) -> Vec<String> {
    let Book {
        space, page, file, ..
    } = book;

    vec![
        format!("head:{account}:{space}:{page}"),
        format!("wire:{account}:{page}"),
        format!("relay:{account}:{space}:mark"),
        format!("relay:{account}:{space}:keyset"),
        format!("rescue:{account}:{space}:{page}"),
        format!("uploaded:{account}:{space}:{file}"),
        format!("shared-text:{account}:{space}:1:{file}"),
        format!("restore:{space}"),
    ]
}

fn account_states(account: Uuid, space: Uuid) -> Vec<String> {
    vec![
        format!("excluded:{account}:{space}"),
        format!("workspace:{account}:{space}"),
    ]
}

fn recognized(store: &mut Store, book: &Book) {
    let job = AttachmentJob {
        space: book.space,
        doc: book.page,
        file: book.file,
        name: FILE_NAME.into(),
    };

    store
        .store_asset(book.space, book.page, book.file, &[1, 2, 3])
        .unwrap();
    store.finish_attachment(&job, "ready", FILE_TEXT).unwrap();
}

fn filled(store: &mut Store, account: Uuid) -> Book {
    let space = Uuid::new_v4();
    let file = Uuid::new_v4();
    let page = page_with_file(space, file);
    let manifest = manifest(space, page.id, Uuid::new_v4());

    store.save(&[manifest, page.clone()], false).unwrap();
    store.keep_version(page.id, Some("Stand"), None).unwrap();
    let book = Book {
        space,
        page: page.id,
        file,
        erased: leave_tombstones(store, space),
    };

    recognized(store, &book);

    for key in sync_states(account, &book)
        .iter()
        .chain(&account_states(account, space))
    {
        store.set_state(key, &[1]).unwrap();
    }

    book
}

fn opened() -> (TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join(DATABASE_FILE), &KEY).unwrap();

    (dir, store)
}

fn raw(dir: &TempDir) -> Connection {
    let conn = Connection::open(dir.path().join(DATABASE_FILE)).unwrap();

    conn.execute_batch(&format!("PRAGMA key=\"x'{}'\"", hex::encode(KEY)))
        .unwrap();

    conn
}

fn count(conn: &Connection, query: &str, space: Uuid) -> i64 {
    conn.query_row(query, [space.to_string()], |r| r.get(0))
        .unwrap()
}

fn total(conn: &Connection, query: &str) -> i64 {
    conn.query_row(query, [], |r| r.get(0)).unwrap()
}

fn states_naming(conn: &Connection, id: Uuid) -> Vec<String> {
    conn.prepare("SELECT id FROM private_state WHERE instr(id,?1)>0 ORDER BY id")
        .unwrap()
        .query_map([id.to_string()], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn deleting_a_notebook_leaves_nothing_of_it_behind() {
    let (dir, mut store) = opened();
    let account = Uuid::new_v4();
    let gone = filled(&mut store, account);

    filled(&mut store, account);
    store.delete_space(gone.space).unwrap();
    let conn = raw(&dir);

    for query in SPACE_ROWS {
        assert_eq!(count(&conn, query, gone.space), 0, "{query}");
    }

    for query in ORPHANS {
        assert_eq!(total(&conn, query), 0, "{query}");
    }

    assert_eq!(
        states_naming(&conn, gone.space),
        account_states(account, gone.space)
    );

    for id in [gone.page, gone.file, gone.erased] {
        assert!(states_naming(&conn, id).is_empty(), "{id}");
    }

    assert!(store.get(gone.page).unwrap().is_none());
    assert!(
        store
            .search_content(gone.space, WORD, None)
            .unwrap()
            .is_empty()
    );
    assert!(!store.has_unsynced_changes(gone.space).unwrap());
}

#[test]
fn the_other_notebooks_keep_everything() {
    let (dir, mut store) = opened();
    let account = Uuid::new_v4();
    let kept = filled(&mut store, account);
    let gone = filled(&mut store, account);

    store.delete_space(gone.space).unwrap();
    let conn = raw(&dir);

    for query in SPACE_ROWS {
        assert!(count(&conn, query, kept.space) > 0, "{query}");
    }

    for key in sync_states(account, &kept) {
        assert!(store.state(&key).unwrap().is_some(), "{key}");
    }

    assert!(
        store
            .state(&format!("asset:{}:{}", kept.space, kept.file))
            .unwrap()
            .is_some()
    );
    assert_eq!(store.versions(kept.page).unwrap().len(), 1);
    assert_eq!(
        store.search_content(kept.space, WORD, None).unwrap().len(),
        2
    );
    assert_eq!(
        store.spaces().unwrap(),
        [(kept.space, WORKSPACE.to_owned())]
    );
}

#[test]
fn only_a_whole_notebook_can_be_deleted() {
    let (_dir, mut store) = opened();
    let book = filled(&mut store, Uuid::new_v4());

    assert!(matches!(store.delete_space(book.page), Err(Error::Invalid)));
    assert!(matches!(
        store.delete_space(Uuid::new_v4()),
        Err(Error::Invalid)
    ));
    store.delete_space(book.space).unwrap();
    assert!(matches!(
        store.delete_space(book.space),
        Err(Error::Invalid)
    ));
}

#[test]
fn a_deleted_notebook_can_arrive_again_under_its_ids() {
    let (_dir, mut store) = opened();
    let book = filled(&mut store, Uuid::new_v4());
    let returning = note(book.space, book.erased, "page");

    assert!(matches!(
        store.save(std::slice::from_ref(&returning), true),
        Err(Error::Conflict)
    ));
    store.delete_space(book.space).unwrap();
    store
        .save(&[note(book.space, book.space, WORKSPACE), returning], true)
        .unwrap();
    assert_eq!(store.spaces().unwrap().len(), 1);
}

#[test]
fn unsynced_changes_last_until_the_relay_confirms_them() {
    let (_dir, mut store) = opened();
    let book = filled(&mut store, Uuid::new_v4());

    assert!(store.has_unsynced_changes(book.space).unwrap());

    for (id, rev) in store.pending(book.space).unwrap() {
        store.acknowledge(book.space, id, rev).unwrap();
    }

    assert!(store.has_unsynced_changes(book.space).unwrap());

    for id in store.deletions(book.space).unwrap() {
        store.deleted(id).unwrap();
    }

    assert!(!store.has_unsynced_changes(book.space).unwrap());
}

#[test]
fn a_notebook_on_disk_reopens_without_the_deleted_one() {
    let (dir, mut store) = opened();
    let account = Uuid::new_v4();
    let kept = filled(&mut store, account);
    let gone = filled(&mut store, account);

    store.delete_space(gone.space).unwrap();
    drop(store);
    let store = Store::open(&dir.path().join(DATABASE_FILE), &KEY).unwrap();

    assert_eq!(
        store.spaces().unwrap(),
        [(kept.space, WORKSPACE.to_owned())]
    );
    assert!(store.get(gone.page).unwrap().is_none());
}
