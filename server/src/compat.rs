use super::*;
use axum::{Json, http::HeaderValue, middleware::Next};
use kladde_protocol::compat::{
    FEATURES_HEADER, FORMAT_HEADER, Feature, Hello, OUTDATED_HEADER, PROTOCOL_HEADER, Peer,
    Refusal, Side,
};

const MAX_DEVICES: i64 = 4096;
const ACTIVE_DAYS: i32 = 30;
const RECORD_EVERY: &str = "1 hour";

pub async fn hello() -> Json<Hello> {
    Json(Hello::relay())
}

pub async fn admit(mut request: Request, next: Next) -> Response {
    match peer_of(request.headers()) {
        Ok(peer) => {
            request.extensions_mut().insert(peer);

            next.run(request).await
        }
        Err(Refusal::Invalid) => StatusCode::BAD_REQUEST.into_response(),
        Err(Refusal::Outdated(side)) => refuse(side),
    }
}

fn peer_of(headers: &HeaderMap) -> std::result::Result<Peer, Refusal> {
    Peer::admit(
        text(headers, PROTOCOL_HEADER)?,
        text(headers, FEATURES_HEADER)?,
        text(headers, FORMAT_HEADER)?,
    )
}

fn text<'a>(headers: &'a HeaderMap, name: &str) -> std::result::Result<Option<&'a str>, Refusal> {
    let mut values = headers.get_all(name).iter();
    let Some(first) = values.next() else {
        return Ok(None);
    };

    if values.next().is_some() {
        return Err(Refusal::Invalid);
    }

    first.to_str().map(Some).map_err(|_| Refusal::Invalid)
}

pub(crate) fn unproven(peer: &Peer) -> Option<Response> {
    (!peer.has(Feature::Proofs)).then(|| refuse(Side::App))
}

fn refuse(side: Side) -> Response {
    let mut response = (StatusCode::UPGRADE_REQUIRED, Json(Hello::relay())).into_response();

    response
        .headers_mut()
        .insert(OUTDATED_HEADER, HeaderValue::from_static(side.name()));
    response
}

pub async fn record_format(relay: &Shared, device: Uuid, format: u8) -> Result<()> {
    query("UPDATE devices SET format=$1,seen=now() WHERE id=$2 AND (format<>$1 OR seen<now()-$3::interval)")
        .bind(i16::from(format))
        .bind(device)
        .bind(RECORD_EVERY)
        .execute(&relay.pool)
        .await?;
    Ok(())
}

pub async fn device_formats(
    State(relay): State<App>,
    headers: HeaderMap,
) -> Result<Json<Vec<(Uuid, u8)>>> {
    let (account, _) = request_owner(&relay, &headers).await?;
    let rows = query("SELECT id,format FROM devices WHERE account=$1 AND NOT revoked AND seen>now()-make_interval(days=>$2) ORDER BY id LIMIT $3")
        .bind(account)
        .bind(ACTIVE_DAYS)
        .bind(MAX_DEVICES)
        .fetch_all(&relay.pool)
        .await?;
    let formats = rows
        .iter()
        .map(|r| {
            Ok((
                r.get(0),
                u8::try_from(r.get::<i16, _>(1)).map_err(|_| bad())?,
            ))
        })
        .collect::<Result<_>>()?;
    Ok(Json(formats))
}
