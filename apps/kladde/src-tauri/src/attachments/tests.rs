use super::{
    encrypted_files::{Local, is_intact},
    uploads::{ACCESS_CHANGED, Uploads},
};

use kladde_crypto as c;
use kladde_protocol::encode;
use uuid::Uuid;

const CONTENT: usize = 2 * c::files::CHUNK + 10;

fn sealed_attachment(doc: Uuid, id: Uuid) -> Vec<u8> {
    let key = c::key();
    let local = Local {
        version: 1,
        id,
        doc,
        key: *key,
        file: c::files::encrypt(&key, &[7; CONTENT]).unwrap(),
        uploaded: true,
    };

    encode(&local).unwrap()
}

#[test]
fn an_untouched_attachment_is_intact() {
    let (doc, id) = (Uuid::new_v4(), Uuid::new_v4());

    assert!(is_intact(&sealed_attachment(doc, id), doc, id));
}

#[test]
fn a_damaged_chunk_is_caught_before_the_attachment_is_kept() {
    let (doc, id) = (Uuid::new_v4(), Uuid::new_v4());
    let mut bytes = sealed_attachment(doc, id);
    let middle = bytes.len() / 2;

    bytes[middle] ^= 1;
    assert!(!is_intact(&bytes, doc, id));
}

#[test]
fn a_job_started_before_an_access_change_seals_nothing_afterwards() {
    let uploads = Uploads::default();
    let lease = uploads.current_lease().unwrap();

    uploads.change_access(|| Ok(())).unwrap();
    assert!(lease.is_cancelled());
    let sealed = uploads.while_leased(&lease, || Ok(()));

    assert_eq!(sealed.unwrap_err(), ACCESS_CHANGED);
}

#[test]
fn a_job_started_after_an_access_change_seals_with_the_new_access() {
    let uploads = Uploads::default();

    uploads.change_access(|| Ok(())).unwrap();
    let lease = uploads.current_lease().unwrap();

    assert_eq!(uploads.while_leased(&lease, || Ok(7)).unwrap(), 7);
}

#[test]
fn a_failed_access_change_still_ends_running_jobs() {
    let uploads = Uploads::default();
    let lease = uploads.current_lease().unwrap();
    let changed: Result<(), String> = uploads.change_access(|| Err("Storage".into()));

    assert!(changed.is_err());
    assert!(lease.is_cancelled());
}

#[tokio::test]
async fn an_access_change_aborts_a_transfer_in_flight() {
    let uploads = Uploads::default();
    let lease = uploads.current_lease().unwrap();
    let transfer = std::future::pending::<()>();

    uploads.change_access(|| Ok(())).unwrap();
    let aborted = tokio::select! {
        () = lease.cancelled() => true,
        () = transfer => false,
    };

    assert!(aborted);
}

#[test]
fn an_attachment_of_another_page_is_not_intact_here() {
    let (doc, id) = (Uuid::new_v4(), Uuid::new_v4());
    let bytes = sealed_attachment(doc, id);

    assert!(!is_intact(&bytes, Uuid::new_v4(), id));
    assert!(!is_intact(&bytes, doc, Uuid::new_v4()));
}
