use kladde_store::Store;
use rusqlite::Connection;
use std::path::Path;

const KEY: [u8; 32] = [7; 32];
const FILLER_BYTES: usize = 4 * 1024 * 1024;
const NO_AUTO_VACUUM: i64 = 0;
const FULL_AUTO_VACUUM: i64 = 1;

fn keyed(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    let key = format!("PRAGMA key=\"x'{}'\"", hex::encode(KEY));

    conn.execute_batch(&key).unwrap();

    conn
}

fn auto_vacuum(path: &Path) -> i64 {
    keyed(path)
        .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
        .unwrap()
}

fn size(path: &Path) -> u64 {
    std::fs::metadata(path).unwrap().len()
}

fn swollen_older_notebook(path: &Path) -> u64 {
    let old = keyed(path);

    old.execute_batch("CREATE TABLE filler(data BLOB)").unwrap();
    old.execute("INSERT INTO filler VALUES(?1)", [vec![1u8; FILLER_BYTES]])
        .unwrap();
    old.execute_batch("DROP TABLE filler").unwrap();
    drop(old);

    size(path)
}

#[test]
fn an_older_notebook_is_rebuilt_once_and_gives_its_free_pages_back() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notebook");
    let swollen = swollen_older_notebook(&path);

    assert_eq!(auto_vacuum(&path), NO_AUTO_VACUUM);
    assert!(swollen > FILLER_BYTES as u64);
    drop(Store::open(&path, &KEY).unwrap());
    assert_eq!(auto_vacuum(&path), FULL_AUTO_VACUUM);
    assert!(size(&path) < swollen / 4);
    let raw = std::fs::read(&path).unwrap();

    assert!(!raw.starts_with(b"SQLite format"));
}

#[test]
fn removed_attachments_shrink_the_notebook_right_away() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notebook");
    let store = Store::open(&path, &KEY).unwrap();

    store
        .set_state("asset:large", &vec![2u8; FILLER_BYTES])
        .unwrap();
    let grown = size(&path);

    assert!(grown > FILLER_BYTES as u64);
    store.clear_state("asset:large").unwrap();
    assert!(size(&path) < grown / 4);
    drop(store);
    assert_eq!(auto_vacuum(&path), FULL_AUTO_VACUUM);
}
