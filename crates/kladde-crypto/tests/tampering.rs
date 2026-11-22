use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305,
    aead::{Aead, Payload},
};

use ed25519_dalek::{Signer, SigningKey};
use kladde_crypto::{
    self as c, Expected, Purpose,
    backup::{Opener, Sealer},
    files,
};

use kladde_protocol::{self as p, Certificate, Envelope, Header, Kind};
use rand::rngs::OsRng;
use uuid::Uuid;

const PURPOSES: [Purpose; 9] = [
    Purpose::Password,
    Purpose::Recovery,
    Purpose::Identity,
    Purpose::Agreement,
    Purpose::Workspace,
    Purpose::File,
    Purpose::Settings,
    Purpose::Backup,
    Purpose::Inbox,
];

struct Fixture {
    identity: SigningKey,
    device: SigningKey,
    workspace: c::Key,
    account: Uuid,
    header: Header,
    cert: Certificate,
}

impl Fixture {
    fn new() -> Self {
        let identity = SigningKey::generate(&mut OsRng);
        let device = SigningKey::generate(&mut OsRng);
        let account = Uuid::new_v4();
        let header = Header {
            version: 1,
            kind: Kind::Update,
            space: Uuid::new_v4(),
            doc: Uuid::new_v4(),
            epoch: 1,
            snapshot: Uuid::new_v4(),
            device: Uuid::new_v4(),
            counter: 1,
            previous: [0; 32],
            nonce: [0; 24],
        };

        let cert = c::certify(
            &identity,
            account,
            header.device,
            device.verifying_key().to_bytes(),
        )
        .unwrap();

        Self {
            identity,
            device,
            workspace: c::key(),
            account,
            header,
            cert,
        }
    }

    fn expected(&self) -> Expected {
        Expected {
            space: self.header.space,
            doc: self.header.doc,
            epoch: self.header.epoch,
            account: self.account,
            counter: self.header.counter,
            previous: self.header.previous,
        }
    }

    fn seal(&self, plain: &[u8]) -> Envelope {
        c::seal(&self.workspace, &self.device, self.header.clone(), plain).unwrap()
    }

    fn open(&self, envelope: &Envelope) -> Result<Vec<u8>, c::Invalid> {
        self.open_with(envelope, &self.cert)
    }

    fn open_with(&self, envelope: &Envelope, cert: &Certificate) -> Result<Vec<u8>, c::Invalid> {
        c::open(
            envelope,
            &self.workspace,
            &self.identity.verifying_key(),
            cert,
            &self.expected(),
        )
        .map(|plain| plain.to_vec())
    }

    fn forge(&self, message: &[u8]) -> Envelope {
        let mut header = self.header.clone();

        header.nonce = [5; 24];
        let doc_key = c::derive(
            self.workspace.as_ref(),
            header.doc.as_bytes(),
            b"kladde/v1/doc",
        )
        .unwrap();
        let mut signed = p::encode(&header).unwrap();
        let body = XChaCha20Poly1305::new(doc_key.as_ref().into())
            .encrypt(
                (&header.nonce).into(),
                Payload {
                    msg: message,
                    aad: &signed,
                },
            )
            .unwrap();
        signed.extend_from_slice(&body);

        Envelope {
            header,
            body,
            signature: self.device.sign(&signed).to_bytes().to_vec(),
        }
    }
}

fn framed(plain: &[u8], padded: usize) -> Vec<u8> {
    let mut message = (plain.len() as u32).to_be_bytes().to_vec();

    message.extend_from_slice(plain);
    message.resize(padded, 0);

    message
}

#[test]
fn every_purpose_is_its_own_key_domain() {
    let secret = c::key();
    let id = Uuid::new_v4();

    for sealed_as in PURPOSES {
        let wrapped = c::wrap(secret.as_ref(), id, sealed_as, b"geheim").unwrap();

        for opened_as in PURPOSES {
            let opened = c::unwrap(secret.as_ref(), id, opened_as, &wrapped);

            assert_eq!(opened.is_ok(), sealed_as == opened_as);
        }
    }
}

#[test]
fn wrapped_keys_refuse_foreign_ids_keys_and_any_altered_byte() {
    let secret = c::key();
    let id = Uuid::new_v4();
    let wrapped = c::wrap(secret.as_ref(), id, Purpose::Inbox, b"Warteschlange").unwrap();
    let wire = p::encode(&wrapped).unwrap();

    assert!(c::unwrap(secret.as_ref(), Uuid::new_v4(), Purpose::Inbox, &wrapped).is_err());
    assert!(c::unwrap(c::key().as_ref(), id, Purpose::Inbox, &wrapped).is_err());

    for index in 0..wire.len() {
        let mut altered = wire.clone();

        altered[index] ^= 0x01;
        let reopened = p::decode::<c::Wrapped>(&altered)
            .ok()
            .and_then(|data| c::unwrap(secret.as_ref(), id, Purpose::Inbox, &data).ok());
        assert!(reopened.is_none(), "byte {index}");
    }

    for length in 0..wire.len() {
        let truncated = p::decode::<c::Wrapped>(&wire[..length])
            .ok()
            .and_then(|data| c::unwrap(secret.as_ref(), id, Purpose::Inbox, &data).ok());
        assert!(truncated.is_none(), "length {length}");
    }
}

#[test]
fn wrapping_twice_never_reuses_a_nonce() {
    let secret = c::key();
    let id = Uuid::new_v4();
    let first = p::encode(&c::wrap(secret.as_ref(), id, Purpose::Backup, b"x").unwrap()).unwrap();
    let second = p::encode(&c::wrap(secret.as_ref(), id, Purpose::Backup, b"x").unwrap()).unwrap();

    assert_ne!(first[1..25], second[1..25]);
    assert_ne!(first, second);
}

#[test]
fn derived_keys_separate_input_salt_and_purpose() {
    let base = c::derive(b"input", b"salt", b"kladde/v1/doc").unwrap();

    assert_eq!(
        *base,
        *c::derive(b"input", b"salt", b"kladde/v1/doc").unwrap()
    );
    assert_ne!(
        *base,
        *c::derive(b"input!", b"salt", b"kladde/v1/doc").unwrap()
    );
    assert_ne!(
        *base,
        *c::derive(b"input", b"salt!", b"kladde/v1/doc").unwrap()
    );
    assert_ne!(
        *base,
        *c::derive(b"input", b"salt", b"kladde/v1/file").unwrap()
    );
}

#[test]
fn a_valid_signature_does_not_replace_the_workspace_key() {
    let fixture = Fixture::new();
    let envelope = fixture.seal(b"Inhalt");

    assert!(c::verify_envelope(&envelope, &fixture.device.verifying_key()).is_ok());
    assert!(
        c::open(
            &envelope,
            &c::key(),
            &fixture.identity.verifying_key(),
            &fixture.cert,
            &fixture.expected(),
        )
        .is_err()
    );
    assert_eq!(fixture.open(&envelope).unwrap(), b"Inhalt");
}

#[test]
fn certificates_bind_identity_account_device_and_key() {
    let fixture = Fixture::new();
    let envelope = fixture.seal(b"Inhalt");
    let identity = fixture.identity.verifying_key();
    let altered = |change: fn(&mut Certificate)| {
        let mut cert = fixture.cert.clone();

        change(&mut cert);

        cert
    };

    let tampered = [
        altered(|cert| cert.device = Uuid::new_v4()),
        altered(|cert| cert.public = SigningKey::generate(&mut OsRng).verifying_key().to_bytes()),
        altered(|cert| cert.signature[10] ^= 1),
        altered(|cert| cert.signature.truncate(63)),
        altered(|cert| cert.version += 1),
    ];

    for cert in &tampered {
        assert!(c::device_key(&identity, fixture.account, cert).is_err());
        assert!(fixture.open_with(&envelope, cert).is_err());
    }

    assert!(c::device_key(&identity, Uuid::new_v4(), &fixture.cert).is_err());
    let foreign = SigningKey::generate(&mut OsRng).verifying_key();

    assert!(c::device_key(&foreign, fixture.account, &fixture.cert).is_err());
    let nil_device = c::certify(
        &fixture.identity,
        fixture.account,
        Uuid::nil(),
        fixture.device.verifying_key().to_bytes(),
    )
    .unwrap();

    assert!(c::device_key(&identity, fixture.account, &nil_device).is_err());
}

#[test]
fn envelopes_reject_foreign_space_device_and_signer() {
    let fixture = Fixture::new();
    let envelope = fixture.seal(b"Inhalt");
    let mut expected = fixture.expected();

    expected.space = Uuid::new_v4();
    assert!(
        c::open(
            &envelope,
            &fixture.workspace,
            &fixture.identity.verifying_key(),
            &fixture.cert,
            &expected
        )
        .is_err()
    );
    let other_signer = SigningKey::generate(&mut OsRng);
    let mut resigned = envelope.clone();
    let mut signed = p::encode(&resigned.header).unwrap();

    signed.extend_from_slice(&resigned.body);
    resigned.signature = other_signer.sign(&signed).to_bytes().to_vec();
    assert!(fixture.open(&resigned).is_err());
    let mut moved = envelope.clone();

    moved.header.device = Uuid::new_v4();
    assert!(fixture.open(&moved).is_err());
    let mut renonced = envelope;

    renonced.header.nonce[0] ^= 1;
    assert!(fixture.open(&renonced).is_err());
}

#[test]
fn sealing_twice_draws_fresh_nonces() {
    let fixture = Fixture::new();
    let first = fixture.seal(b"gleich");
    let second = fixture.seal(b"gleich");

    assert_ne!(first.header.nonce, second.header.nonce);
    assert_ne!(first.body, second.body);
    assert_ne!(c::hash(&first).unwrap(), c::hash(&second).unwrap());
}

#[test]
fn padding_hides_small_differences_in_length() {
    let fixture = Fixture::new();
    let shorter = fixture.seal(&vec![1; 1_000_000]);
    let longer = fixture.seal(&vec![1; 1_000_010]);

    assert_eq!(shorter.body.len(), longer.body.len());
    assert!(shorter.body.len() > 1_000_010);
}

#[test]
fn authenticated_but_malformed_padding_is_refused() {
    let fixture = Fixture::new();

    assert_eq!(
        fixture.open(&fixture.forge(&framed(b"ok", 6))).unwrap(),
        b"ok"
    );
    let mut overlong = framed(b"abc", 7);

    overlong[3] = 200;
    assert!(fixture.open(&fixture.forge(&overlong)).is_err());
    let mut lying = framed(b"x", 64);

    lying[..4].copy_from_slice(&u32::MAX.to_be_bytes());
    assert!(fixture.open(&fixture.forge(&lying)).is_err());
    assert!(fixture.open(&fixture.forge(&framed(b"ok", 64))).is_err());
}

#[test]
fn recovery_phrases_must_be_complete_valid_english_bip39() {
    let words = c::recovery(&c::key()).unwrap();
    let list: Vec<&str> = words.split_whitespace().collect();

    assert!(c::recover(&list[..12].join(" ")).is_err());
    assert!(c::recover(&list[..23].join(" ")).is_err());
    let twelve = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    assert!(c::recover(twelve).is_err());
    assert!(c::recover("").is_err());
    assert!(c::recover(&format!("{} kladde", list[..23].join(" "))).is_err());
}

#[test]
fn backup_passwords_outside_the_allowed_length_are_refused_before_hashing() {
    let salt = [4; 16];

    assert!(c::backup_key(b"", &salt).is_err());
    assert!(c::backup_key(&[b'a'; 11], &salt).is_err());
    assert!(c::backup_key(&[b'a'; 1025], &salt).is_err());
}

#[test]
fn file_streams_refuse_wrong_keys_versions_and_altered_chunks() {
    let secret = c::key();
    let data = vec![3; files::CHUNK + 10];
    let file = files::encrypt(&secret, &data).unwrap();
    let wire = p::encode(&file).unwrap();
    let (version, nonce, chunks): (u8, [u8; 19], Vec<Vec<u8>>) = p::decode(&wire).unwrap();
    let rebuild = |version: u8, nonce: [u8; 19], chunks: &Vec<Vec<u8>>| {
        p::decode::<files::File>(&p::encode(&(version, nonce, chunks)).unwrap()).unwrap()
    };

    assert_eq!(chunks.len(), 2);
    assert!(files::decrypt(&c::key(), &file).is_err());
    assert!(files::decrypt(&secret, &rebuild(2, nonce, &chunks)).is_err());
    let mut other_nonce = nonce;

    other_nonce[0] ^= 1;
    assert!(files::decrypt(&secret, &rebuild(version, other_nonce, &chunks)).is_err());
    let mut flipped = chunks.clone();

    flipped[1][0] ^= 1;
    assert!(files::decrypt(&secret, &rebuild(version, nonce, &flipped)).is_err());
    let mut extended = chunks.clone();

    extended.push(chunks[1].clone());
    assert!(files::decrypt(&secret, &rebuild(version, nonce, &extended)).is_err());
    assert!(files::decrypt(&secret, &rebuild(version, nonce, &Vec::new())).is_err());
    assert_eq!(*files::decrypt(&secret, &file).unwrap(), data);
}

#[test]
fn file_chunks_of_impossible_size_are_refused_while_decoding() {
    let nonce = [0u8; 19];

    for chunk in [vec![0u8; 15], vec![0u8; files::CHUNK + 17]] {
        let wire = p::encode(&(1u8, nonce, vec![chunk])).unwrap();

        assert!(p::decode_attachment::<files::File>(&wire).is_err());
    }
}

#[test]
fn empty_and_chunk_sized_files_round_trip_with_a_final_chunk() {
    let secret = c::key();

    for size in [0, files::CHUNK, files::CHUNK + 1] {
        let data = vec![8; size];
        let file = files::encrypt(&secret, &data).unwrap();
        let (_, _, chunks): (u8, [u8; 19], Vec<Vec<u8>>) =
            p::decode_attachment(&p::encode(&file).unwrap()).unwrap();

        assert_eq!(chunks.len(), size.div_ceil(files::CHUNK).max(1));
        assert_eq!(*files::decrypt(&secret, &file).unwrap(), data);
    }

    assert!(files::encrypt(&secret, &vec![0; p::MAX_ATTACHMENT_BYTES + 1]).is_err());
}

#[test]
fn backup_streams_bind_key_space_nonce_and_final_marker() {
    let secret = c::key();
    let space = Uuid::new_v4();
    let nonce = [9; 19];
    let mut sealer = Sealer::new(&secret, space, &nonce, b"kopf".to_vec()).unwrap();
    let first = sealer.next(b"").unwrap();
    let last = sealer.last(b"ende").unwrap();
    let opener = |key: &c::Key, space: Uuid, nonce: &[u8; 19]| {
        Opener::new(key, space, nonce, b"kopf".to_vec()).unwrap()
    };

    assert!(opener(&c::key(), space, &nonce).next(&first).is_err());
    assert!(
        opener(&secret, Uuid::new_v4(), &nonce)
            .next(&first)
            .is_err()
    );
    assert!(opener(&secret, space, &[8; 19]).next(&first).is_err());
    let mut extended = opener(&secret, space, &nonce);

    assert!(extended.next(&first).unwrap().is_empty());
    assert!(extended.next(&last).is_err());
    let mut truncated = last.clone();

    truncated.pop();
    let mut cut = opener(&secret, space, &nonce);

    cut.next(&first).unwrap();
    assert!(cut.last(&truncated).is_err());
    let mut complete = opener(&secret, space, &nonce);

    complete.next(&first).unwrap();
    assert_eq!(complete.last(&last).unwrap().as_slice(), b"ende");
}
