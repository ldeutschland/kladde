mod auth;
mod blobs;
mod closings;
mod compat;
mod space_documents;
mod sync_socket;
mod throttle;
use axum::{
    Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};

use blobs::storage::{BlobStorage, Volume};

use kladde_crypto::opaque::{ServerSetup, Suite};
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};
use sqlx_core::{
    error::{Error as DatabaseFault, ErrorKind},
    query::query,
    row::Row,
};

use sqlx_postgres::{PgPool, PgPoolOptions};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};

use uuid::Uuid;
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, Fault>;

#[derive(Debug)]
struct Fault(StatusCode);

impl IntoResponse for Fault {
    fn into_response(self) -> Response {
        self.0.into_response()
    }
}

impl From<DatabaseFault> for Fault {
    fn from(error: DatabaseFault) -> Self {
        let refused = match &error {
            DatabaseFault::RowNotFound => true,
            DatabaseFault::Database(cause) => !matches!(cause.kind(), ErrorKind::Other),
            _ => false,
        };

        Fault(if refused {
            StatusCode::CONFLICT
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        })
    }
}

impl From<kladde_protocol::Invalid> for Fault {
    fn from(_: kladde_protocol::Invalid) -> Self {
        bad()
    }
}

fn bad() -> Fault {
    Fault(StatusCode::BAD_REQUEST)
}

fn denied() -> Fault {
    Fault(StatusCode::UNAUTHORIZED)
}

struct Shared {
    pool: PgPool,
    setup: ServerSetup<Suite>,
    challenges: Mutex<HashMap<Uuid, (Instant, auth::challenges::Challenge)>>,
    logins: throttle::Throttle,
    clients: Option<throttle::Throttle>,
    client_requests: Option<throttle::Throttle>,
    account_requests: throttle::Throttle,
    account_messages: throttle::Throttle,
    sockets: Mutex<HashMap<Uuid, u8>>,
    uploads: Mutex<HashMap<Uuid, u8>>,
    downloads: Mutex<HashMap<Uuid, u8>>,
    blobs: Volume,
    decoys: kladde_crypto::Key,
    watchers:
        Mutex<HashMap<Uuid, tokio::sync::broadcast::Sender<sync_socket::change_feed::Change>>>,
    history: tokio::sync::Semaphore,
    quota: i64,
}

type App = Arc<Shared>;

fn token_hash(headers: &HeaderMap) -> Result<[u8; 32]> {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(denied)?;
    if bearer.len() != 64 || !bearer.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(denied());
    }

    Ok(Sha256::digest(bearer.as_bytes()).into())
}

const UNLIMITED_QUOTA: i64 = i64::MAX;
const ROW_CHARGE: i64 = 256;
const BLOB_CHARGE_FLOOR: i64 = 4096;
const MIN_QUOTA: i64 = 1024 * 1024;

fn account_quota() -> std::result::Result<i64, &'static str> {
    match std::env::var("ACCOUNT_QUOTA_BYTES") {
        Ok(value) => parsed_quota(&value),
        Err(_) => Ok(UNLIMITED_QUOTA),
    }
}

fn trusts_forwarded_for() -> std::result::Result<bool, &'static str> {
    match std::env::var("TRUST_FORWARDED_FOR").as_deref() {
        Err(std::env::VarError::NotPresent) | Ok("0") => Ok(false),
        Ok("1") => Ok(true),
        _ => Err("TRUST_FORWARDED_FOR must be 0 or 1"),
    }
}

fn throttled() -> Fault {
    Fault(StatusCode::TOO_MANY_REQUESTS)
}

fn admit_forwarded(clients: Option<&throttle::Throttle>, headers: &HeaderMap) -> Result<()> {
    let Some(clients) = clients else {
        return Ok(());
    };

    let client = throttle::forwarded_client(headers).ok_or_else(bad)?;

    if !clients.allow(&client) {
        return Err(throttled());
    }

    Ok(())
}

async fn request_owner(relay: &Shared, headers: &HeaderMap) -> Result<(Uuid, Uuid)> {
    admit_forwarded(relay.client_requests.as_ref(), headers)?;
    let owner = session_owner(relay, &token_hash(headers)?).await?;

    if !relay.account_requests.allow(&owner.0.to_string()) {
        return Err(throttled());
    }

    Ok(owner)
}

fn parsed_quota(value: &str) -> std::result::Result<i64, &'static str> {
    match value.trim().parse::<i64>() {
        Ok(quota) if quota >= MIN_QUOTA => Ok(quota),
        _ => Err("ACCOUNT_QUOTA_BYTES must be a whole number of at least 1048576"),
    }
}

async fn session_owner(relay: &Shared, hash: &[u8]) -> Result<(Uuid, Uuid)> {
    let row=query("SELECT s.account,s.device FROM sessions s JOIN devices d ON d.id=s.device WHERE s.token=$1 AND s.expires>now() AND NOT d.revoked").bind(hash).fetch_optional(&relay.pool).await?.ok_or_else(denied)?;

    Ok((row.get(0), row.get(1)))
}

async fn erase_orphaned_blobs(pool: &PgPool, volume: &Volume) -> std::io::Result<()> {
    for account in volume.accounts().await? {
        let known = query("SELECT 1 FROM accounts WHERE id=$1")
            .bind(account)
            .fetch_optional(pool)
            .await
            .map_err(std::io::Error::other)?;
        if known.is_none() {
            volume.erase_account(account).await?;
        }
    }

    Ok(())
}

async fn require_member(relay: &Shared, account: Uuid, space: Uuid) -> Result<()> {
    if query("SELECT 1 FROM memberships WHERE account=$1 AND space=$2")
        .bind(account)
        .bind(space)
        .fetch_optional(&relay.pool)
        .await?
        .is_none()
    {
        return Err(denied());
    }

    Ok(())
}

type Startup<T> = std::result::Result<T, Box<dyn std::error::Error>>;

const DEFAULT_LISTEN_ADDR: &str = "127.0.0.1:7341";
const MAX_CONNECTIONS: u32 = 12;
const MAX_REQUEST_BODY: usize = 131072;
const MAX_ROTATION_BODY: usize = 64 * 1024 * 1024;
const MAX_CLOSING_BODY: usize = 64 * 1024 * 1024;

fn write_setup_file(path: &str) -> Startup<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(&ServerSetup::<Suite>::new(&mut OsRng).serialize())?;
    file.sync_all()?;

    Ok(())
}

async fn open_database() -> Startup<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .connect(&std::env::var("DATABASE_URL")?)
        .await
        .map_err(|_| "PostgreSQL unavailable")?;
    sqlx_core::raw_sql::raw_sql(include_str!("schema.sql"))
        .execute(&pool)
        .await?;

    Ok(pool)
}

async fn open_blob_volume(pool: &PgPool) -> Startup<Volume> {
    let blobs = PathBuf::from(std::env::var("BLOB_DIR")?);

    std::fs::create_dir_all(&blobs)?;
    let blobs = Volume(blobs);

    erase_orphaned_blobs(pool, &blobs).await?;
    blobs.erase_unfinished().await?;

    Ok(blobs)
}

async fn shared_state() -> Startup<App> {
    let quota = account_quota()?;
    let forwarded = trusts_forwarded_for()?;
    let pool = open_database().await?;
    let bytes = Zeroizing::new(std::fs::read(std::env::var("OPAQUE_SETUP_FILE")?)?);
    let setup = ServerSetup::<Suite>::deserialize(&bytes).map_err(|_| "Invalid OPAQUE setup")?;
    let decoys = kladde_crypto::derive(&bytes, &[], auth::recovery::DECOY_SEED)?;
    let blobs = open_blob_volume(&pool).await?;

    Ok(Arc::new(Shared {
        pool,
        setup,
        blobs,
        challenges: Mutex::default(),
        logins: throttle::Throttle::logins(),
        clients: forwarded.then(throttle::Throttle::clients),
        client_requests: forwarded.then(throttle::Throttle::client_requests),
        account_requests: throttle::Throttle::account_requests(),
        account_messages: throttle::Throttle::account_messages(),
        sockets: Mutex::default(),
        uploads: Mutex::default(),
        downloads: Mutex::default(),
        decoys,
        watchers: Mutex::default(),
        history: tokio::sync::Semaphore::new(sync_socket::HISTORY_BUDGET_KIB),
        quota,
    }))
}

fn account_routes() -> Router<App> {
    Router::new()
        .route(
            "/v1/register/start",
            post(auth::registration::register_start),
        )
        .route(
            "/v1/register/finish",
            post(auth::registration::register_finish),
        )
        .route("/v1/login/start", post(auth::login::login_start))
        .route("/v1/login/finish", post(auth::login::login_finish))
        .route("/v1/enroll", post(auth::login::enroll))
        .route("/v1/session/start", post(auth::sessions::renew_start))
        .route("/v1/session/renew", post(auth::sessions::renew_finish))
        .route("/v1/session", delete(auth::sessions::logout))
        .route("/v1/recovery/start", post(auth::recovery::recovery_start))
        .route("/v1/recovery/keys", post(auth::recovery::recovery_keys))
        .route(
            "/v1/recovery/finish",
            post(auth::recovery::recovery_finish).layer(DefaultBodyLimit::max(MAX_ROTATION_BODY)),
        )
        .route(
            "/v1/workspaces",
            get(auth::account::list_spaces).post(auth::account::add_space),
        )
        .route(
            "/v1/workspaces/{space}",
            delete(auth::account::remove_space),
        )
        .route("/v1/devices", get(auth::account::devices))
        .route("/v1/devices/formats", get(compat::device_formats))
        .route("/v1/account", delete(auth::account::erase))
}

fn sync_routes() -> Router<App> {
    Router::new()
        .route("/v1/sync", get(sync_socket::socket))
        .route("/v1/spaces/{space}/docs", get(space_documents::documents))
        .route(
            "/v1/spaces/{space}/state",
            get(space_documents::space_state),
        )
        .route(
            "/v1/spaces/{space}/docs/{id}",
            delete(space_documents::purge),
        )
        .route("/v1/spaces/{space}/discard", post(space_documents::discard))
        .route("/v1/spaces/{space}/blobs", get(blobs::list_blobs))
        .route("/v1/spaces/{space}/closings", get(closings::closings))
        .route(
            "/v1/spaces/{space}/closing",
            put(closings::share_closing).layer(DefaultBodyLimit::max(MAX_CLOSING_BODY)),
        )
        .route(
            "/v1/spaces/{space}/blobs/{id}",
            get(blobs::get_blob)
                .put(blobs::put_blob)
                .delete(blobs::erase_blob),
        )
}

fn router(app: App) -> Router {
    let open = Router::new()
        .route("/health", get(|| async { StatusCode::NO_CONTENT }))
        .route("/v1/hello", get(compat::hello));
    let api = account_routes()
        .merge(sync_routes())
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY))
        .layer(axum::middleware::from_fn(compat::admit))
        .with_state(app);

    open.merge(api)
}

#[tokio::main]
async fn main() -> Startup<()> {
    let args: Vec<_> = std::env::args().collect();

    if args.get(1).map(String::as_str) == Some("init-setup") {
        let path = args.get(2).ok_or("Expected a private setup file path")?;

        return write_setup_file(path);
    }

    let app = shared_state().await?;
    let addr = std::env::var("LISTEN_ADDR").unwrap_or_else(|_| DEFAULT_LISTEN_ADDR.into());
    let listener = tokio::net::TcpListener::bind(addr).await?;

    axum::serve(listener, router(app)).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MIN_QUOTA, parsed_quota};

    #[test]
    fn configured_quota_needs_a_whole_number_above_the_minimum() {
        assert_eq!(parsed_quota("8388608"), Ok(8_388_608));
        assert_eq!(parsed_quota(" 1048576\n"), Ok(MIN_QUOTA));
        assert!(parsed_quota("1048575").is_err());
        assert!(parsed_quota("unlimited").is_err());
        assert!(parsed_quota("").is_err());
    }
}
