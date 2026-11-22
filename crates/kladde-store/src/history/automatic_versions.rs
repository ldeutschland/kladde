use super::{LARGE_CHANGE, REMOTE, change_size::changes_much};
use crate::{Error, Note};
use rusqlite::{Connection, OptionalExtension, params};

const PAUSE: u64 = 30;
const STEADY: u64 = 3 * 60;
pub(super) const HOUR: i64 = 60 * 60;
pub(super) const DAY: i64 = 24 * HOUR;
const WEEK: i64 = 7 * DAY;
const MAX_AGE: i64 = 365 * DAY;
const ANCHOR_AGE: i64 = 30 * DAY;
pub(super) const MAX_ANCHORS: i64 = 100;
const ROUTINE_TIERS: [(i64, i64); 2] = [(HOUR, 10 * 60), (DAY, DAY)];
pub(super) const UNVERSIONED_KIND: &str = "index";
const CAPTURE: &str = "INSERT INTO versions(id,rev,time,record,cause,origin) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id,rev) DO UPDATE SET origin=CASE WHEN versions.cause IS NULL THEN excluded.origin ELSE versions.origin END,cause=COALESCE(versions.cause,excluded.cause)";
const EXPIRE: &str = "DELETE FROM versions WHERE id=?1 AND label IS NULL AND time<?2";
const DEMOTE: &str = "UPDATE versions SET cause=NULL WHERE id=?1 AND label IS NULL AND cause IS NOT NULL AND rev NOT IN (SELECT rev FROM versions WHERE id=?1 AND label IS NULL AND cause IS NOT NULL ORDER BY rev DESC LIMIT ?2)";
const THIN_ROUTINE: &str = "DELETE FROM versions WHERE id=?1 AND label IS NULL AND cause IS NULL AND time<?2 AND rev NOT IN (SELECT max(rev) FROM versions WHERE id=?1 AND label IS NULL AND cause IS NULL AND time<?2 GROUP BY time/?3)";
const THIN_UNNAMED: &str = "DELETE FROM versions WHERE id=?1 AND label IS NULL AND time<?2 AND rev NOT IN (SELECT max(rev) FROM versions WHERE id=?1 AND label IS NULL AND time<?2 GROUP BY time/?3)";

fn saved_at(db: &Connection, id: &str) -> Result<Option<i64>, Error> {
    let time = db.query_row("SELECT time FROM save_times WHERE id=?1", [id], |r| {
        r.get(0)
    });

    Ok(time.optional()?)
}

fn latest_time(db: &Connection, id: &str) -> Result<Option<i64>, Error> {
    Ok(
        db.query_row("SELECT max(time) FROM versions WHERE id=?1", [id], |r| {
            r.get(0)
        })?,
    )
}

pub(crate) fn mark_saved(db: &Connection, id: &str, now: i64) -> Result<(), Error> {
    db.execute(
        "INSERT INTO save_times VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET time=excluded.time",
        params![id, now],
    )?;

    Ok(())
}

pub(crate) fn capture(
    db: &Connection,
    previous: &Note,
    next: &Note,
    now: i64,
    remote: bool,
) -> Result<(), Error> {
    let id = previous.id.to_string();

    if previous.kind == UNVERSIONED_KIND {
        db.execute("DELETE FROM versions WHERE id=?1", [&id])?;

        return Ok(());
    }

    let paused = saved_at(db, &id)?.is_none_or(|time| now.abs_diff(time) >= PAUSE);
    let steady = latest_time(db, &id)?.is_none_or(|time| now.abs_diff(time) >= STEADY);
    let large = changes_much(&previous.body, &next.body);

    if !paused && !steady && !large {
        return Ok(());
    }

    let cause = large.then_some(LARGE_CHANGE);
    let origin = (large && remote).then_some(REMOTE);
    let record = kladde_protocol::encode(previous).map_err(|_| Error::Invalid)?;

    db.execute(
        CAPTURE,
        params![id, previous.rev, now, record, cause, origin],
    )?;

    thin(db, &id, now)
}

fn thin(db: &Connection, id: &str, now: i64) -> Result<(), Error> {
    db.execute(EXPIRE, params![id, now - MAX_AGE])?;
    db.execute(DEMOTE, params![id, MAX_ANCHORS])?;

    for (age, span) in ROUTINE_TIERS {
        db.execute(THIN_ROUTINE, params![id, now - age, span])?;
    }

    db.execute(THIN_UNNAMED, params![id, now - ANCHOR_AGE, WEEK])?;

    Ok(())
}
