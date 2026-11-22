use super::{change_feed::announce, reply};
use crate::{
    ROW_CHARGE, Result, Shared, auth::checks::device_public, bad, denied, require_member,
    space_documents::next_mark,
};

use axum::extract::ws::WebSocket;
use kladde_protocol::{
    Envelope, Header, Kind, Server,
    compat::{Feature, Peer},
    encode,
};

use sha2::{Digest, Sha256};
use sqlx_core::{query::query, row::Row};
use uuid::Uuid;

enum Recorded {
    Stored(i64),
    Repeated(i64),
    Conflict,
    Full,
}

pub(crate) async fn push(
    relay: &Shared,
    ws: &mut WebSocket,
    peer: &Peer,
    account: Uuid,
    device: Uuid,
    envelope: Envelope,
    snapshot: Option<(Option<Uuid>, i64)>,
) -> Result<()> {
    envelope.validate()?;
    let header = &envelope.header;

    require_member(relay, account, header.space).await?;

    if header.device != device || header.counter > i64::MAX as u64 {
        return Err(denied());
    }

    let signer = device_public(relay, account, device).await?;

    kladde_crypto::verify_envelope(&envelope, &signer).map_err(|_| denied())?;
    let answer = match record_push(relay, account, &envelope, snapshot).await? {
        Recorded::Stored(seq) => {
            let changed = Server::Changed {
                space: header.space,
                doc: header.doc,
                seq,
            };

            announce(relay, header.space, device, &changed);

            Server::Ack {
                doc: header.doc,
                seq,
            }
        }
        Recorded::Repeated(seq) => Server::Ack {
            doc: header.doc,
            seq,
        },
        Recorded::Conflict => Server::Conflict,
        Recorded::Full if peer.has(Feature::Full) => Server::Full,
        Recorded::Full => return Err(bad()),
    };

    reply(ws, &answer).await
}

type Connection = sqlx_postgres::PgConnection;

async fn record_push(
    relay: &Shared,
    account: Uuid,
    envelope: &Envelope,
    snapshot: Option<(Option<Uuid>, i64)>,
) -> Result<Recorded> {
    let header = &envelope.header;
    let mut tx = relay.pool.begin().await?;
    let mark = next_mark(&mut tx, header.space).await?;

    refuse_deleted(&mut tx, header).await?;
    let (old, current) = lock_document(&mut tx, header).await?;
    let wire = encode(envelope)?;
    let digest = Sha256::digest(&wire);

    if let Some(earlier) = earlier_push(&mut tx, header, digest.as_slice()).await? {
        return Ok(earlier);
    }

    if !continues_document(header, snapshot, old, current) {
        return Ok(Recorded::Conflict);
    }

    if !charge_quota(&mut tx, relay, account, wire.len() as i64 + ROW_CHARGE).await? {
        return Ok(Recorded::Full);
    }

    let seq = old.checked_add(1).ok_or_else(bad)?;

    store_update(&mut tx, header, seq, digest.as_slice(), &wire).await?;

    if let Some((parent, covers)) = snapshot {
        store_snapshot(&mut tx, header, parent, covers, seq).await?;
    }

    advance_document(&mut tx, header, seq, mark).await?;
    tx.commit().await?;

    Ok(Recorded::Stored(seq))
}

async fn refuse_deleted(tx: &mut Connection, header: &Header) -> Result<()> {
    if query("SELECT 1 FROM deletions WHERE space=$1 AND id=$2")
        .bind(header.space)
        .bind(header.doc)
        .fetch_optional(&mut *tx)
        .await?
        .is_some()
    {
        return Err(denied());
    }

    Ok(())
}

async fn lock_document(tx: &mut Connection, header: &Header) -> Result<(i64, Option<Uuid>)> {
    query("INSERT INTO documents(id,space) VALUES($1,$2) ON CONFLICT DO NOTHING")
        .bind(header.doc)
        .bind(header.space)
        .execute(&mut *tx)
        .await?;
    let row = query("SELECT seq,snapshot FROM documents WHERE id=$1 AND space=$2 FOR UPDATE")
        .bind(header.doc)
        .bind(header.space)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(denied)?;

    Ok((row.get(0), row.get(1)))
}

async fn earlier_push(
    tx: &mut Connection,
    header: &Header,
    digest: &[u8],
) -> Result<Option<Recorded>> {
    let Some(row) = query(
        "SELECT seq,digest FROM updates WHERE space=$1 AND doc=$2 AND device=$3 AND counter=$4",
    )
    .bind(header.space)
    .bind(header.doc)
    .bind(header.device)
    .bind(header.counter as i64)
    .fetch_optional(&mut *tx)
    .await?
    else {
        return Ok(None);
    };

    if row.get::<Vec<u8>, _>(1) != digest {
        return Ok(Some(Recorded::Conflict));
    }

    Ok(Some(Recorded::Repeated(row.get(0))))
}

fn continues_document(
    header: &Header,
    snapshot: Option<(Option<Uuid>, i64)>,
    old: i64,
    current: Option<Uuid>,
) -> bool {
    match snapshot {
        Some((parent, covers)) => parent == current && covers == old,
        None => Some(header.snapshot) == current,
    }
}

async fn charge_quota(
    tx: &mut Connection,
    relay: &Shared,
    account: Uuid,
    size: i64,
) -> Result<bool> {
    let consumed = query("UPDATE accounts SET used=used+$1 WHERE id=$2 AND used+$1<=$3")
        .bind(size)
        .bind(account)
        .bind(relay.quota)
        .execute(&mut *tx)
        .await?;

    Ok(consumed.rows_affected() == 1)
}

async fn store_update(
    tx: &mut Connection,
    header: &Header,
    seq: i64,
    digest: &[u8],
    wire: &[u8],
) -> Result<()> {
    query("INSERT INTO updates(space,doc,seq,device,counter,digest,wire) VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(header.space)
        .bind(header.doc)
        .bind(seq)
        .bind(header.device)
        .bind(header.counter as i64)
        .bind(digest)
        .bind(wire)
        .execute(&mut *tx)
        .await?;

    Ok(())
}

async fn store_snapshot(
    tx: &mut Connection,
    header: &Header,
    parent: Option<Uuid>,
    covers: i64,
    seq: i64,
) -> Result<()> {
    query("INSERT INTO snapshots(space,doc,id,parent,covers,seq) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(header.space)
        .bind(header.doc)
        .bind(header.snapshot)
        .bind(parent)
        .bind(covers)
        .bind(seq)
        .execute(&mut *tx)
        .await?;

    Ok(())
}

async fn advance_document(tx: &mut Connection, header: &Header, seq: i64, mark: i64) -> Result<()> {
    let checkpoint = header.kind == Kind::Checkpoint;

    query("UPDATE documents SET seq=$1,snapshot=$2,base=CASE WHEN $4 THEN $1 ELSE base END,mark=$5 WHERE id=$3 AND space=$6")
        .bind(seq)
        .bind(header.snapshot)
        .bind(header.doc)
        .bind(checkpoint)
        .bind(mark)
        .bind(header.space)
        .execute(&mut *tx)
        .await?;

    if checkpoint {
        trim_history(tx, header.space, header.doc, seq).await?;
    }

    Ok(())
}

async fn trim_history(tx: &mut Connection, space: Uuid, doc: Uuid, base: i64) -> Result<()> {
    query("WITH old AS (SELECT seq,device,octet_length(wire)::bigint AS size FROM updates WHERE space=$3 AND doc=$1 AND seq<$2 AND wire IS NOT NULL), cleared AS (UPDATE updates u SET wire=NULL FROM old WHERE u.space=$3 AND u.doc=$1 AND u.seq=old.seq RETURNING old.device,old.size), freed AS (SELECT d.account,SUM(c.size)::bigint AS size FROM cleared c JOIN devices d ON d.id=c.device GROUP BY d.account) UPDATE accounts a SET used=GREATEST(0,a.used-freed.size) FROM freed WHERE a.id=freed.account")
        .bind(doc)
        .bind(base)
        .bind(space)
        .execute(tx)
        .await?;
    Ok(())
}
