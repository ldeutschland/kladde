use ed25519_dalek::SigningKey;
use kladde_crypto as crypto;
use kladde_protocol::{self as p, Certificate, Checkpoint, Client, Envelope, Header, Kind};
use kladde_sync::{Cursor, account::Access};
use uuid::Uuid;

struct Team {
    account: Uuid,
    space: Uuid,
    identity: SigningKey,
}

type Relay = Vec<(Envelope, Certificate)>;

fn team() -> Team {
    Team {
        account: Uuid::new_v4(),
        space: Uuid::new_v4(),
        identity: SigningKey::from_bytes(&[17; 32]),
    }
}

fn member(team: &Team, seed: u8) -> Access {
    let signer = SigningKey::from_bytes(&[seed; 32]);
    let cert = crypto::certify(
        &team.identity,
        team.account,
        Uuid::new_v4(),
        signer.verifying_key().to_bytes(),
    )
    .unwrap();
    let mut access = Access {
        origin: String::new(),
        username: String::new(),
        token: String::new(),
        account: team.account,
        space: team.space,
        master: [1; 32],
        workspace: vec![],
        identity: team.identity.verifying_key().to_bytes(),
        device_key: signer.to_bytes(),
        cert,
    };

    access.use_keyset(&[2; 32]).unwrap();

    access
}

fn sealed(request: Client) -> Envelope {
    match request {
        Client::PushUpdate(e) | Client::PushSnapshot { envelope: e, .. } => e,
        _ => panic!("unexpected request"),
    }
}

fn catch_up(cursor: &mut Cursor, reader: &Access, doc: Uuid, relay: &Relay) {
    while (cursor.seq as usize) < relay.len() {
        let (envelope, cert) = &relay[cursor.seq as usize];

        cursor
            .accept(reader, doc, cursor.seq + 1, envelope, cert)
            .unwrap();
    }
}

fn publish(cursor: &mut Cursor, author: &Access, doc: Uuid, relay: &mut Relay, text: &[u8]) {
    catch_up(cursor, author, doc, relay);
    let envelope = sealed(cursor.push_with(author, doc, text, true).unwrap());

    cursor
        .accept(author, doc, cursor.seq + 1, &envelope, &author.cert)
        .unwrap();
    relay.push((envelope, author.cert.clone()));
}

struct Story {
    mac: Access,
    phone: Access,
    reader: Access,
    doc: Uuid,
    relay: Relay,
    mac_cursor: Cursor,
}

fn story() -> Story {
    let team = team();
    let mac = member(&team, 23);
    let phone = member(&team, 29);
    let reader = member(&team, 31);
    let doc = Uuid::new_v4();
    let mut relay = Relay::new();
    let mut mac_cursor = Cursor::default();
    let mut phone_cursor = Cursor::default();

    publish(&mut mac_cursor, &mac, doc, &mut relay, b"genesis");
    publish(&mut phone_cursor, &phone, doc, &mut relay, b"phone one");
    publish(&mut phone_cursor, &phone, doc, &mut relay, b"phone two");
    publish(&mut mac_cursor, &mac, doc, &mut relay, b"mac one");
    mac_cursor.updates = 64;
    publish(&mut mac_cursor, &mac, doc, &mut relay, b"handover");
    publish(&mut phone_cursor, &phone, doc, &mut relay, b"after");

    Story {
        mac,
        phone,
        reader,
        doc,
        relay,
        mac_cursor,
    }
}

const CHECKPOINT_SEQ: i64 = 5;

fn checkpoint(s: &Story) -> &(Envelope, Certificate) {
    &s.relay[CHECKPOINT_SEQ as usize - 1]
}

#[test]
fn snapshots_become_checkpoints_and_updates_stay_updates() {
    let s = story();
    let kinds: Vec<Kind> = s.relay.iter().map(|(e, _)| e.header.kind).collect();

    assert_eq!(
        kinds,
        [
            Kind::Checkpoint,
            Kind::Update,
            Kind::Update,
            Kind::Update,
            Kind::Checkpoint,
            Kind::Update
        ]
    );
    let legacy = Cursor::default()
        .push(&s.mac, s.doc, b"plain")
        .map(sealed)
        .unwrap();
    assert_eq!(legacy.header.kind, Kind::Snapshot);
}

#[test]
fn a_sequential_reader_verifies_the_checkpoint_heads() {
    let s = story();
    let mut cursor = Cursor::default();

    catch_up(&mut cursor, &s.reader, s.doc, &s.relay);
    assert_eq!(cursor.seq, s.relay.len() as i64);
    assert_eq!(cursor.heads.len(), 2);
}

#[test]
fn a_fresh_reader_starts_at_the_checkpoint_and_follows_the_chain() {
    let s = story();
    let (envelope, cert) = checkpoint(&s);
    let mut cursor = Cursor::default();
    let data = cursor
        .accept(&s.reader, s.doc, CHECKPOINT_SEQ, envelope, cert)
        .unwrap();
    assert_eq!(data.as_slice(), b"handover");
    assert_eq!(cursor.heads, s.mac_cursor.heads);
    let (after, cert) = &s.relay[CHECKPOINT_SEQ as usize];
    let data = cursor
        .accept(&s.reader, s.doc, CHECKPOINT_SEQ + 1, after, cert)
        .unwrap();
    assert_eq!(data.as_slice(), b"after");
}

#[test]
fn a_device_behind_jumps_forward_without_losing_its_own_chain() {
    let s = story();
    let mut cursor = Cursor::default();

    for (index, (envelope, cert)) in s.relay.iter().take(2).enumerate() {
        cursor
            .accept(&s.phone, s.doc, index as i64 + 1, envelope, cert)
            .unwrap();
    }

    let own = cursor.heads[&s.phone.cert.device];
    let (envelope, cert) = checkpoint(&s);

    cursor
        .accept(&s.phone, s.doc, CHECKPOINT_SEQ, envelope, cert)
        .unwrap();
    assert!(cursor.heads[&s.phone.cert.device].0 > own.0);
    let next = sealed(cursor.push_with(&s.phone, s.doc, b"next", true).unwrap());

    assert_eq!(next.header.kind, Kind::Update);
}

#[test]
fn jumps_need_a_checkpoint_at_its_own_position() {
    let s = story();
    let (update, cert) = &s.relay[3];

    assert!(
        Cursor::default()
            .accept(&s.reader, s.doc, 4, update, cert)
            .is_err()
    );
    let (envelope, cert) = checkpoint(&s);

    assert!(
        Cursor::default()
            .accept(&s.reader, s.doc, CHECKPOINT_SEQ + 2, envelope, cert)
            .is_err()
    );
    let mut ahead = Cursor::default();

    catch_up(&mut ahead, &s.reader, s.doc, &s.relay);
    assert!(
        ahead
            .accept(&s.reader, s.doc, CHECKPOINT_SEQ, envelope, cert)
            .is_err()
    );
}

fn forged(s: &Story, tamper: impl Fn(&mut (u64, [u8; 32]))) -> Envelope {
    let mut author = Cursor::default();
    let prefix: Relay = s.relay[..CHECKPOINT_SEQ as usize - 1].to_vec();

    catch_up(&mut author, &s.mac, s.doc, &prefix);
    tamper(author.heads.get_mut(&s.phone.cert.device).unwrap());
    author.updates = 64;

    sealed(author.push_with(&s.mac, s.doc, b"forged", true).unwrap())
}

fn reader_at(s: &Story, seq: i64) -> Cursor {
    let mut cursor = Cursor::default();
    let prefix: Relay = s.relay[..seq as usize].to_vec();

    catch_up(&mut cursor, &s.reader, s.doc, &prefix);

    cursor
}

#[test]
fn a_checkpoint_cannot_roll_back_a_known_device() {
    let s = story();
    let rolled_back = forged(&s, |head| head.0 -= 1);
    let mut next = reader_at(&s, CHECKPOINT_SEQ - 1);

    assert!(
        next.accept(&s.reader, s.doc, CHECKPOINT_SEQ, &rolled_back, &s.mac.cert)
            .is_err()
    );
    let mut behind = reader_at(&s, 3);

    assert!(
        behind
            .accept(&s.reader, s.doc, CHECKPOINT_SEQ, &rolled_back, &s.mac.cert)
            .is_err()
    );
    assert_eq!(behind.seq, 3);
}

#[test]
fn a_checkpoint_cannot_rewrite_a_known_envelope() {
    let s = story();
    let rewritten = forged(&s, |head| head.1[0] ^= 1);
    let mut behind = reader_at(&s, 3);

    assert!(
        behind
            .accept(&s.reader, s.doc, CHECKPOINT_SEQ, &rewritten, &s.mac.cert)
            .is_err()
    );
    let mut next = reader_at(&s, CHECKPOINT_SEQ - 1);

    assert!(
        next.accept(&s.reader, s.doc, CHECKPOINT_SEQ, &rewritten, &s.mac.cert)
            .is_err()
    );
}

fn handover(s: &Story, skip: u64) -> Envelope {
    let known = reader_at(s, CHECKPOINT_SEQ - 1);
    let (last, previous) = known.heads[&s.mac.cert.device];
    let point = Checkpoint {
        covers: known.seq,
        heads: known
            .heads
            .iter()
            .map(|(device, (counter, hash))| (*device, *counter, *hash))
            .collect(),
        data: b"handover".to_vec(),
    };

    let header = Header {
        version: 1,
        kind: Kind::Checkpoint,
        space: s.mac.space,
        doc: s.doc,
        epoch: 1,
        snapshot: Uuid::new_v4(),
        device: s.mac.cert.device,
        counter: last + 1 + skip,
        previous,
        nonce: [0; 24],
    };

    let (key, _) = s.mac.epoch_keys(1).unwrap();

    crypto::seal(
        &key,
        &SigningKey::from_bytes(&s.mac.device_key),
        header,
        &p::encode(&point).unwrap(),
    )
    .unwrap()
}

#[test]
fn a_checkpoint_must_continue_its_authors_chain() {
    let s = story();
    let honest = handover(&s, 0);

    assert!(
        Cursor::default()
            .accept(&s.reader, s.doc, CHECKPOINT_SEQ, &honest, &s.mac.cert)
            .is_ok()
    );
    let skipping = handover(&s, 1);

    assert!(
        Cursor::default()
            .accept(&s.reader, s.doc, CHECKPOINT_SEQ, &skipping, &s.mac.cert)
            .is_err()
    );
}
