use ed25519_dalek::SigningKey;
use kladde_crypto as crypto;
use kladde_protocol::{
    self as p, Client, Envelope,
    account::{MAX_EPOCHS, MAX_JSON_KEYS, MAX_WRAPPED_KEYS},
};

use kladde_sync::{
    Cursor,
    account::{Access, Ring, extend_keyset, keyset},
};

use serde::Serialize;
use std::collections::BTreeMap;
use uuid::Uuid;

struct Account {
    id: Uuid,
    space: Uuid,
}

fn device(owner: &Account, identity: &SigningKey, keys: &[u8], seed: u8) -> Access {
    let signer = SigningKey::from_bytes(&[seed; 32]);
    let cert = crypto::certify(
        identity,
        owner.id,
        Uuid::new_v4(),
        signer.verifying_key().to_bytes(),
    )
    .unwrap();
    let mut access = Access {
        origin: String::new(),
        username: String::new(),
        token: String::new(),
        account: owner.id,
        space: owner.space,
        master: [1; 32],
        workspace: vec![],
        identity: identity.verifying_key().to_bytes(),
        device_key: signer.to_bytes(),
        cert,
    };

    access.use_keyset(keys).unwrap();

    access
}

fn envelope(request: Client) -> Envelope {
    match request {
        Client::PushUpdate(e) | Client::PushSnapshot { envelope: e, .. } => e,
        _ => panic!("unexpected request"),
    }
}

#[test]
fn rotation_shuts_out_the_removed_device() {
    let owner = Account {
        id: Uuid::new_v4(),
        space: Uuid::new_v4(),
    };

    let doc = Uuid::new_v4();
    let old_identity = SigningKey::from_bytes(&[3; 32]);
    let new_identity = SigningKey::from_bytes(&[4; 32]);
    let first = extend_keyset(&[], &old_identity.verifying_key().to_bytes()).unwrap();
    let second = extend_keyset(&first, &new_identity.verifying_key().to_bytes()).unwrap();
    let removed = device(&owner, &old_identity, &first, 5);
    let honest = device(&owner, &new_identity, &second, 6);
    let reader = device(&owner, &new_identity, &second, 7);
    let mut author = Cursor::default();
    let early = envelope(author.push(&removed, doc, b"before").unwrap());

    author
        .accept(&removed, doc, 1, &early, &removed.cert)
        .unwrap();
    let mut receiving = Cursor::default();
    let plain = receiving
        .accept(&reader, doc, 1, &early, &removed.cert)
        .unwrap();
    assert_eq!(plain.as_slice(), b"before");
    assert!(receiving.needs_rekey_snapshot(&reader));
    let snapshot = envelope(receiving.push(&honest, doc, b"after").unwrap());

    assert_eq!(snapshot.header.epoch, 2);
    let mut forging = author.clone();

    forging.snapshot = None;
    let late = envelope(forging.push(&removed, doc, b"forged").unwrap());

    assert_eq!((late.header.epoch, late.header.counter), (1, 2));
    let mut stolen = device(&owner, &new_identity, &second, 5);

    stolen.cert = removed.cert.clone();
    let impostor = envelope(receiving.push(&stolen, doc, b"forged").unwrap());

    assert!(
        receiving
            .accept(&reader, doc, 2, &impostor, &removed.cert)
            .is_err()
    );
    receiving
        .accept(&reader, doc, 2, &snapshot, &honest.cert)
        .unwrap();
    assert!(!receiving.needs_rekey_snapshot(&reader));
    assert!(
        receiving
            .accept(&reader, doc, 3, &late, &removed.cert)
            .is_err()
    );
    assert!(receiving.push(&removed, doc, b"stale").is_err());
}

#[derive(Serialize)]
struct LegacyCursor {
    seq: i64,
    heads: BTreeMap<Uuid, (u64, [u8; 32])>,
    snapshot: Option<Uuid>,
    updates: u32,
    bytes: u64,
}

#[test]
fn legacy_keys_and_cursors_remain_readable() {
    let identity = SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes();
    let other = SigningKey::from_bytes(&[9; 32]).verifying_key().to_bytes();
    let legacy = keyset(&[2; 32], &identity).unwrap();

    assert_eq!(&legacy[..32], &[2; 32]);
    assert_eq!(&legacy[32..], &identity);
    assert!(keyset(&legacy, &other).is_err());
    assert!(keyset(&legacy[..40], &identity).is_err());
    let mut full = legacy.to_vec();

    for _ in 1..kladde_sync::account::MAX_EPOCHS {
        full = extend_keyset(&full, &identity).unwrap().to_vec();
    }

    assert!(keyset(&full, &identity).is_ok());
    assert!(extend_keyset(&full, &identity).is_err());
    let old = LegacyCursor {
        seq: 3,
        heads: BTreeMap::new(),
        snapshot: Some(Uuid::new_v4()),
        updates: 2,
        bytes: 10,
    };

    let cursor = Cursor::decode(&p::encode(&old).unwrap()).unwrap();

    assert_eq!(
        (cursor.seq, cursor.epoch, cursor.snapshot),
        (3, 1, old.snapshot)
    );
    let again = Cursor::decode(&p::encode(&cursor).unwrap()).unwrap();

    assert_eq!((again.seq, again.epoch), (3, 1));
}

#[test]
fn the_largest_key_sets_still_fit_through_the_relay() {
    let identity = SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes();
    let mut full = Vec::new();

    for _ in 0..MAX_EPOCHS {
        full = extend_keyset(&full, &identity).unwrap().to_vec();
    }

    let (account, space) = (Uuid::new_v4(), Uuid::new_v4());
    let wrap = |id, purpose, plain: &[u8]| crypto::wrap(&[1; 32], id, purpose, plain).unwrap();
    let ring = Ring {
        password: wrap(account, crypto::Purpose::Password, &[2; 32]),
        recovery: wrap(account, crypto::Purpose::Recovery, &[2; 32]),
        identity: wrap(account, crypto::Purpose::Identity, &[2; 32]),
        agreement: wrap(account, crypto::Purpose::Agreement, &[2; 32]),
        workspace: wrap(space, crypto::Purpose::Workspace, &full),
    };

    let account_keys = p::encode(&ring).unwrap();
    let space_keys = p::encode(&wrap(space, crypto::Purpose::Workspace, &full)).unwrap();

    for wrapped in [account_keys, space_keys] {
        assert!(wrapped.len() <= MAX_WRAPPED_KEYS);
        assert!(serde_json::to_vec(&wrapped).unwrap().len() <= MAX_JSON_KEYS);
    }
}
