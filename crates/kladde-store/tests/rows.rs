use kladde_store::{Note, ROW_PAGE, Store};
use uuid::Uuid;
use yrs::{Doc, ReadTxn, StateVector, Transact};

fn open() -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("notebook"), &[7; 32]).unwrap();

    (store, dir)
}

fn note(space: Uuid, id: Uuid, kind: &str, parent: Option<Uuid>, title: &str, rev: i64) -> Note {
    Note {
        id,
        space,
        kind: kind.into(),
        title: title.into(),
        body: String::new(),
        parent,
        archived: false,
        props: "{}".into(),
        links: vec![],
        data: Doc::new()
            .transact()
            .encode_state_as_update_v1(&StateVector::default()),
        rev,
    }
}

fn database_with(store: &mut Store, count: usize) -> (Uuid, Uuid, Vec<Uuid>) {
    let (space, database) = (Uuid::new_v4(), Uuid::new_v4());
    let rows: Vec<Uuid> = (0..count).map(|_| Uuid::new_v4()).collect();

    store
        .save(
            &[note(space, space, "workspace", None, "Notizbuch", 0)],
            false,
        )
        .unwrap();
    store
        .save(
            &[note(space, database, "database", None, "Datenbank", 0)],
            false,
        )
        .unwrap();
    for batch in rows.chunks(1000) {
        let notes: Vec<Note> = batch
            .iter()
            .map(|id| note(space, *id, "row", Some(database), "Zeile", 0))
            .collect();
        store.save(&notes, false).unwrap();
    }

    (space, database, rows)
}

#[test]
fn rows_come_in_pages_beyond_the_first() {
    let (mut store, _dir) = open();
    let extra = 700;
    let (space, database, rows) = database_with(&mut store, ROW_PAGE as usize + extra);
    let first = store.rows_page(space, database, 0).unwrap();

    assert_eq!(first.len(), ROW_PAGE as usize);
    let second = store
        .rows_page(space, database, first.last().unwrap().0)
        .unwrap();
    assert_eq!(second.len(), extra);
    let mut seen: Vec<Uuid> = first.iter().chain(&second).map(|row| row.1).collect();

    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), rows.len());
}

#[test]
fn later_calls_report_edited_trashed_and_removed_rows() {
    let (mut store, _dir) = open();
    let (space, database, rows) = database_with(&mut store, 5);
    let since = store.row_mark().unwrap();

    assert!(
        store
            .rows_changed(space, database, since)
            .unwrap()
            .is_empty()
    );
    store
        .save(
            &[note(space, rows[0], "row", Some(database), "umbenannt", 1)],
            false,
        )
        .unwrap();
    let mut trashed = note(space, rows[1], "row", Some(database), "Zeile", 1);

    trashed.archived = true;
    store.save(&[trashed], false).unwrap();
    store.forget(rows[1]).unwrap();
    let changes = store.rows_changed(space, database, since).unwrap();
    let renamed = changes.iter().find(|row| row.1 == rows[0]).unwrap();

    assert_eq!((renamed.2.as_str(), renamed.4), ("umbenannt", false));
    let removed = changes.iter().find(|row| row.1 == rows[1]).unwrap();

    assert!(removed.4);
    assert_eq!(changes.len(), 2);
    let latest = changes.last().unwrap().0;

    assert!(
        store
            .rows_changed(space, database, latest)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn marks_keep_rising_after_another_database_is_forgotten() {
    let (mut store, _dir) = open();
    let (space, database, rows) = database_with(&mut store, 3);
    let (_, newest, _) = database_with(&mut store, 5);
    let since = store.row_mark().unwrap();

    store.forget(newest).unwrap();
    assert_eq!(store.row_mark().unwrap(), since);
    store
        .save(
            &[note(space, rows[0], "row", Some(database), "umbenannt", 1)],
            false,
        )
        .unwrap();
    let changes = store.rows_changed(space, database, since).unwrap();

    assert_eq!(changes.len(), 1);
    assert_eq!(
        (changes[0].1, changes[0].2.as_str()),
        (rows[0], "umbenannt")
    );
}

#[test]
fn an_older_notebook_starts_its_clock_at_the_newest_mark() {
    let (mut store, dir) = open();
    let (space, database, rows) = database_with(&mut store, 4);
    let newest = store.row_mark().unwrap();

    drop(store);
    let path = dir.path().join("notebook");
    let raw = rusqlite::Connection::open(&path).unwrap();
    let key = format!("PRAGMA key=\"x'{}'\"", "07".repeat(32));

    raw.execute_batch(&key).unwrap();
    raw.execute_batch("DROP TABLE row_clock").unwrap();
    drop(raw);
    let mut store = Store::open(&path, &[7; 32]).unwrap();

    assert_eq!(store.row_mark().unwrap(), newest);
    store
        .save(
            &[note(space, rows[0], "row", Some(database), "umbenannt", 1)],
            false,
        )
        .unwrap();
    let changes = store.rows_changed(space, database, newest).unwrap();

    assert_eq!(changes.len(), 1);
}
