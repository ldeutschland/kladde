use crate::{Error, Store, backup, history, listing, search};
use rusqlite::Connection;
use std::path::Path;
use zeroize::Zeroizing;

const SCHEMA_VERSION: i64 = 7;
const FULL_AUTO_VACUUM: i64 = 1;
const MAX_REBUILT_BYTES: i64 = 256 * 1024 * 1024;
const USED_BYTES: &str = "SELECT (c.page_count-f.freelist_count)*s.page_size FROM pragma_page_count() c,pragma_freelist_count() f,pragma_page_size() s";

fn release_free_pages(db: &Connection) -> Result<(), Error> {
    let mode: i64 = db.query_row("PRAGMA auto_vacuum", [], |r| r.get(0))?;

    if mode == FULL_AUTO_VACUUM {
        return Ok(());
    }

    db.execute_batch("PRAGMA auto_vacuum=FULL")?;
    let used: i64 = db.query_row(USED_BYTES, [], |r| r.get(0))?;

    if used > MAX_REBUILT_BYTES {
        return Ok(());
    }

    let _ = db.execute_batch("VACUUM");

    Ok(())
}

impl Store {
    pub fn open(path: &Path, key: &[u8; 32]) -> Result<Self, Error> {
        let conn = Connection::open(path)?;
        let raw = Zeroizing::new(format!("PRAGMA key=\"x'{}'\"", hex::encode(key)));

        conn.execute_batch(&raw)?;
        let cipher: String = conn.query_row("PRAGMA cipher_version", [], |r| r.get(0))?;

        if cipher.is_empty() {
            return Err(Error::Invalid);
        }

        conn.execute_batch("PRAGMA cipher_memory_security=ON; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON; PRAGMA trusted_schema=OFF;")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

        if version > SCHEMA_VERSION {
            return Err(Error::Invalid);
        }

        release_free_pages(&conn)?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        conn.execute_batch(include_str!("schema.sql"))?;
        history::add_columns(&conn)?;

        if version == 1 {
            search::backfill(&conn)?;
        }

        if version == 2 {
            conn.execute("UPDATE page_files SET status='pending',retry_at=0 WHERE status IN ('ready','partial')", [])?;
        }

        if version < 4 {
            listing::rebuild(&conn)?;
        }

        if version < 6 {
            search::reindex(&conn)?;
        }

        if version < 7 {
            conn.execute(
                "UPDATE page_files SET status='pending',retry_at=0 WHERE status='unsupported'",
                [],
            )?;
        }

        backup::abandon_all(&conn)?;
        conn.execute_batch("COMMIT")?;

        Ok(Self(conn))
    }
}
