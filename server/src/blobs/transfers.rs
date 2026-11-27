use crate::{App, Fault, Result, Shared, bad};
use axum::{body::Bytes, http::StatusCode};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tokio::{
    io::AsyncReadExt,
    sync::mpsc,
    time::{Instant, timeout_at},
};

use uuid::Uuid;

const READ_CHUNK: usize = 64 * 1024;
const TRANSFER_START: Duration = Duration::from_secs(60);
pub(crate) const TRANSFER_IDLE: Duration = Duration::from_secs(30);
const SLOWEST_TRANSFER: u64 = 32 * 1024;
type Counts = Mutex<HashMap<Uuid, u8>>;

pub(crate) struct Limit {
    per_account: u8,
    total: usize,
    counts: fn(&Shared) -> &Counts,
}

pub(crate) const UPLOADS: Limit = Limit {
    per_account: 2,
    total: 128,
    counts: upload_counts,
};

pub(crate) const DOWNLOADS: Limit = Limit {
    per_account: 16,
    total: 512,
    counts: download_counts,
};

fn upload_counts(relay: &Shared) -> &Counts {
    &relay.uploads
}

fn download_counts(relay: &Shared) -> &Counts {
    &relay.downloads
}

pub(crate) struct Slot {
    relay: App,
    account: Uuid,
    counts: fn(&Shared) -> &Counts,
}

impl Drop for Slot {
    fn drop(&mut self) {
        if let Ok(mut counts) = (self.counts)(&self.relay).lock()
            && let Some(n) = counts.get_mut(&self.account)
        {
            *n -= 1;

            if *n == 0 {
                counts.remove(&self.account);
            }
        }
    }
}

pub(crate) fn take_slot(relay: &App, account: Uuid, limit: &Limit) -> Result<Slot> {
    let mut counts = (limit.counts)(relay).lock().map_err(|_| bad())?;
    let running: usize = counts.values().map(|n| usize::from(*n)).sum();

    if running >= limit.total {
        return Err(Fault(StatusCode::SERVICE_UNAVAILABLE));
    }

    let mine = counts.get(&account).copied().unwrap_or(0);

    if mine >= limit.per_account {
        return Err(Fault(StatusCode::TOO_MANY_REQUESTS));
    }

    counts.insert(account, mine + 1);

    Ok(Slot {
        relay: relay.clone(),
        account,
        counts: limit.counts,
    })
}

fn slowest_pace(moved: u64) -> Duration {
    TRANSFER_START + Duration::from_secs(moved / SLOWEST_TRANSFER)
}

pub(crate) fn transfer_deadline(size: u64) -> Instant {
    Instant::now() + slowest_pace(size)
}

fn next_due(deadline: Instant, idle: Duration, started: Instant, moved: u64) -> Instant {
    deadline
        .min(started + slowest_pace(moved))
        .min(Instant::now() + idle)
}

pub(crate) fn paced(body: axum::body::Body, deadline: Instant, idle: Duration) -> axum::body::Body {
    let started = Instant::now();
    let chunks = body.into_data_stream();
    let timed = futures_util::stream::unfold((chunks, 0), move |(mut chunks, moved)| async move {
        let next = futures_util::StreamExt::next(&mut chunks);
        let item = match timeout_at(next_due(deadline, idle, started, moved), next).await {
            Ok(item) => item?.map_err(std::io::Error::other),
            Err(_) => Err(std::io::ErrorKind::TimedOut.into()),
        };

        let moved = moved + item.as_ref().map_or(0, |chunk| chunk.len() as u64);

        Some((item, (chunks, moved)))
    });

    axum::body::Body::from_stream(timed)
}

async fn delivered<T>(sender: &mpsc::Sender<T>, item: T, due: Instant) -> bool {
    matches!(timeout_at(due, sender.send(item)).await, Ok(Ok(())))
}

pub(crate) fn file_chunks<G: Send + 'static>(
    mut file: tokio::fs::File,
    held: G,
    deadline: Instant,
    idle: Duration,
) -> impl futures_util::Stream<Item = std::io::Result<Bytes>> {
    let (sender, receiver) = mpsc::channel(2);
    let started = Instant::now();

    tokio::spawn(async move {
        let _held = held;
        let mut moved = 0;

        loop {
            let mut chunk = vec![0u8; READ_CHUNK];
            let item = match file.read(&mut chunk).await {
                Ok(0) => return,
                Ok(read) => Ok(Bytes::from(chunk[..read].to_vec())),
                Err(e) => Err(e),
            };

            let last = item.is_err();
            let due = next_due(deadline, idle, started, moved);

            moved += item.as_ref().map_or(0, |chunk| chunk.len() as u64);

            if !delivered(&sender, item, due).await || last {
                return;
            }
        }
    });

    futures_util::stream::unfold(receiver, |mut receiver| async move {
        let item = receiver.recv().await?;

        Some((item, receiver))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHORT: Duration = Duration::from_millis(50);

    #[tokio::test]
    async fn a_stalled_upload_ends_after_the_idle_time() {
        let silent = futures_util::stream::pending::<std::io::Result<Bytes>>();
        let body = paced(
            axum::body::Body::from_stream(silent),
            Instant::now() + Duration::from_secs(60),
            SHORT,
        );
        let started = Instant::now();
        let read = axum::body::to_bytes(body, 1024).await;

        assert!(read.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn an_upload_ends_at_its_deadline_even_while_data_trickles() {
        let trickle = futures_util::stream::unfold((), |()| async {
            tokio::time::sleep(Duration::from_millis(10)).await;

            Some((Ok::<_, std::io::Error>(Bytes::from_static(b"x")), ()))
        });
        let body = paced(
            axum::body::Body::from_stream(trickle),
            Instant::now() + SHORT,
            SHORT,
        );

        assert!(axum::body::to_bytes(body, usize::MAX).await.is_err());
    }

    #[test]
    fn a_transfer_has_to_keep_the_slowest_pace_from_its_start() {
        let started = Instant::now();
        let hour = Duration::from_secs(3600);
        let deadline = started + hour;

        assert_eq!(
            next_due(deadline, hour, started, 0),
            started + TRANSFER_START
        );
        assert_eq!(
            next_due(deadline, hour, started, SLOWEST_TRANSFER * 30),
            started + TRANSFER_START + Duration::from_secs(30)
        );
        assert_eq!(
            next_due(deadline, hour, started, SLOWEST_TRANSFER * 7200),
            deadline
        );
    }

    #[tokio::test]
    async fn a_download_nobody_reads_releases_its_slot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob");

        std::fs::write(&path, vec![1u8; READ_CHUNK * 8]).unwrap();
        let file = tokio::fs::File::open(&path).await.unwrap();
        let slot = std::sync::Arc::new(());
        let stalled = file_chunks(
            file,
            slot.clone(),
            Instant::now() + Duration::from_secs(60),
            SHORT,
        );

        tokio::time::sleep(SHORT * 6).await;
        assert_eq!(std::sync::Arc::strong_count(&slot), 1);
        drop(stalled);
    }

    #[tokio::test]
    async fn a_download_read_in_time_arrives_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob");
        let blob: Vec<u8> = (0..READ_CHUNK * 3 + 7).map(|i| i as u8).collect();

        std::fs::write(&path, &blob).unwrap();
        let file = tokio::fs::File::open(&path).await.unwrap();
        let chunks = file_chunks(file, (), Instant::now() + Duration::from_secs(60), SHORT);
        let body = axum::body::Body::from_stream(chunks);

        assert_eq!(axum::body::to_bytes(body, usize::MAX).await.unwrap(), blob);
    }
}
