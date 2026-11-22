use super::{SEND_TIMEOUT, reply};
use crate::{Result, Shared, bad};
use axum::extract::ws::WebSocket;
use kladde_protocol::{
    Envelope, Server,
    compat::{Feature, Peer},
    decode,
};

use sqlx_core::{query::query, row::Row};
use sqlx_postgres::PgRow;
use tokio::sync::SemaphorePermit;
use uuid::Uuid;

const HISTORY_PAGE: i64 = 8;
const HISTORY_PAGE_BYTES: i64 = 8 * 1024 * 1024;
const KIB: u64 = 1024;

async fn doc_position(relay: &Shared, space: Uuid, doc: Uuid) -> Result<(i64, i64)> {
    Ok(
        query("SELECT seq,base FROM documents WHERE id=$1 AND space=$2")
            .bind(doc)
            .bind(space)
            .fetch_optional(&relay.pool)
            .await?
            .map_or((0, 0), |r| (r.get(0), r.get(1))),
    )
}

fn first_served(last_seq: i64, base: i64) -> i64 {
    last_seq.max(base - 1)
}

async fn rebase(relay: &Shared, space: Uuid, doc: Uuid, cursor: i64) -> Result<(i64, i64)> {
    let (head, base) = doc_position(relay, space, doc).await?;
    let start = base - 1;

    if start <= cursor || start > head {
        return Err(bad());
    }

    Ok((head, start))
}

async fn page_sizes(
    relay: &Shared,
    space: Uuid,
    doc: Uuid,
    cursor: i64,
    head: i64,
) -> Result<Vec<(i64, i64)>> {
    let rows = query("SELECT seq,coalesce(octet_length(wire),0) FROM updates WHERE doc=$1 AND space=$2 AND seq>$3 AND seq<=$4 ORDER BY seq LIMIT $5")
        .bind(doc)
        .bind(space)
        .bind(cursor)
        .bind(head)
        .bind(HISTORY_PAGE)
        .fetch_all(&relay.pool)
        .await?;

    Ok(rows
        .iter()
        .map(|r| (r.get(0), i64::from(r.get::<i32, _>(1))))
        .collect())
}

fn page_end(sizes: &[(i64, i64)]) -> Option<(i64, i64)> {
    let mut end = None;
    let mut bytes = 0;

    for &(seq, size) in sizes {
        if end.is_some() && bytes + size > HISTORY_PAGE_BYTES {
            break;
        }

        end = Some(seq);
        bytes += size;
    }

    end.map(|seq| (seq, bytes))
}

async fn reserve_history(relay: &Shared, bytes: i64) -> Result<SemaphorePermit<'_>> {
    let size = u64::try_from(bytes).map_err(|_| bad())?;
    let kib = u32::try_from(size.div_ceil(KIB).max(1)).map_err(|_| bad())?;

    match tokio::time::timeout(SEND_TIMEOUT, relay.history.acquire_many(kib)).await {
        Ok(Ok(permit)) => Ok(permit),
        _ => Err(bad()),
    }
}

async fn fetch_page(
    relay: &Shared,
    space: Uuid,
    doc: Uuid,
    cursor: i64,
    head: i64,
) -> Result<(SemaphorePermit<'_>, Vec<PgRow>)> {
    let sizes = page_sizes(relay, space, doc, cursor, head).await?;
    let (end, bytes) = page_end(&sizes).ok_or_else(bad)?;
    let reserved = reserve_history(relay, bytes).await?;
    let rows=query("SELECT u.seq,u.wire,d.cert FROM updates u JOIN devices d ON u.device=d.id WHERE u.doc=$1 AND u.space=$2 AND u.seq>$3 AND u.seq<=$4 ORDER BY u.seq").bind(doc).bind(space).bind(cursor).bind(end).fetch_all(&relay.pool).await?;

    if rows.is_empty() {
        return Err(bad());
    }

    Ok((reserved, rows))
}

pub(crate) async fn send_history(
    relay: &Shared,
    ws: &mut WebSocket,
    peer: &Peer,
    space: Uuid,
    doc: Uuid,
    last_seq: i64,
) -> Result<bool> {
    let (mut head, base) = doc_position(relay, space, doc).await?;

    if last_seq < 0 || last_seq > head {
        return Ok(false);
    }

    let mut cursor = first_served(last_seq, base);

    while cursor < head {
        let (_reserved, rows) = fetch_page(relay, space, doc, cursor, head).await?;

        for r in rows {
            let Some(wire) = r.get::<Option<Vec<u8>>, _>(1) else {
                (head, cursor) = rebase(relay, space, doc, cursor).await?;
                break;
            };

            cursor = r.get(0);
            let envelope: Envelope = decode(&wire)?;

            if !peer.reads(&envelope.header) {
                return refuse_unreadable(ws, peer, doc).await;
            }

            reply(
                ws,
                &Server::Item {
                    seq: cursor,
                    envelope,
                    certificate: decode(&r.get::<Vec<u8>, _>(2))?,
                },
            )
            .await?
        }
    }

    reply(ws, &Server::Head { doc, seq: head }).await?;

    Ok(true)
}

async fn refuse_unreadable(ws: &mut WebSocket, peer: &Peer, doc: Uuid) -> Result<bool> {
    if !peer.has(Feature::Outdated) {
        return Err(bad());
    }

    reply(ws, &Server::Outdated { doc }).await?;

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: i64 = 1024 * 1024;

    #[test]
    fn a_history_page_stops_before_the_byte_budget_but_keeps_one_envelope() {
        assert_eq!(page_end(&[]), None);
        assert_eq!(page_end(&[(4, 7 * MIB)]), Some((4, 7 * MIB)));
        assert_eq!(page_end(&[(4, 7 * MIB), (5, 2 * MIB)]), Some((4, 7 * MIB)));
        assert_eq!(
            page_end(&[(1, MIB), (2, 0), (3, 7 * MIB)]),
            Some((3, 8 * MIB))
        );
        assert_eq!(
            page_end(&[(1, 5 * MIB), (2, 4 * MIB), (3, MIB)]),
            Some((1, 5 * MIB))
        );
    }
}
