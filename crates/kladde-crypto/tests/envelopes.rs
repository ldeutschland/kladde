use ed25519_dalek::SigningKey;
use kladde_crypto::{self as c, Expected};
use kladde_protocol::{self as p, Header, Kind};
use proptest::prelude::*;
use rand::rngs::OsRng;
use uuid::Uuid;

fn header() -> Header {
    Header {
        version: 1,
        kind: Kind::Snapshot,
        space: Uuid::new_v4(),
        doc: Uuid::new_v4(),
        epoch: 1,
        snapshot: Uuid::new_v4(),
        device: Uuid::new_v4(),
        counter: 1,
        previous: [0; 32],
        nonce: [0; 24],
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]
    #[test]
    fn authenticated_roundtrip(bytes in proptest::collection::vec(any::<u8>(),0..16384), pos in any::<usize>()){
        let id=SigningKey::generate(&mut OsRng);let device=SigningKey::generate(&mut OsRng);let key=c::key();let h=header();let account=Uuid::new_v4();
        let cert=c::certify(&id,account,h.device,device.verifying_key().to_bytes()).unwrap();
        let mut expected=Expected{account,space:h.space,doc:h.doc,epoch:h.epoch,counter:1,previous:[0;32]};
        let e=c::seal(&key,&device,h,&bytes).unwrap();let plain=c::open(&e,&key,&id.verifying_key(),&cert,&expected).unwrap();prop_assert_eq!(plain.as_slice(),bytes.as_slice());
        let mut data=p::encode(&e).unwrap();let index=pos%data.len();data[index]^=1;

        prop_assert!(p::decode::<p::Envelope>(&data).ok().and_then(|e|c::open(&e,&key,&id.verifying_key(),&cert,&expected).ok()).is_none());
        expected.epoch=2;prop_assert!(c::open(&e,&key,&id.verifying_key(),&cert,&expected).is_err());expected.epoch=1;expected.doc=Uuid::new_v4();prop_assert!(c::open(&e,&key,&id.verifying_key(),&cert,&expected).is_err());
    }
}

#[test]
fn every_byte_and_chain_context_are_authenticated() {
    let id = SigningKey::generate(&mut OsRng);
    let device = SigningKey::generate(&mut OsRng);
    let k = c::key();
    let h = header();
    let account = Uuid::new_v4();
    let cert = c::certify(&id, account, h.device, device.verifying_key().to_bytes()).unwrap();
    let mut expected = Expected {
        account,
        space: h.space,
        doc: h.doc,
        epoch: 1,
        counter: 1,
        previous: [0; 32],
    };

    let e = c::seal(&k, &device, h, b"private").unwrap();
    let encoded = p::encode(&e).unwrap();

    for i in 0..encoded.len() {
        let mut b = encoded.clone();

        b[i] ^= 128;

        if let Ok(e) = p::decode(&b) {
            assert!(c::open(&e, &k, &id.verifying_key(), &cert, &expected).is_err())
        }
    }

    expected.counter = 2;
    assert!(c::open(&e, &k, &id.verifying_key(), &cert, &expected).is_err());
    expected.counter = 1;
    expected.previous = c::hash(&e).unwrap();
    assert!(c::open(&e, &k, &id.verifying_key(), &cert, &expected).is_err());
}

#[test]
fn recovery_stream_and_wrapping_domains() {
    let k = c::key();
    let words = c::recovery(&k).unwrap();

    assert_eq!(words.split_whitespace().count(), 24);
    assert_eq!(*k, *c::recover(&words).unwrap());
    let id = Uuid::new_v4();
    let wrapped = c::wrap(k.as_ref(), id, c::Purpose::Password, b"master").unwrap();

    assert!(c::unwrap(k.as_ref(), id, c::Purpose::Recovery, &wrapped).is_err());
    let data = vec![9; c::files::CHUNK * 2 + 2];
    let file = c::files::encrypt(&k, &data).unwrap();

    assert_eq!(*c::files::decrypt(&k, &file).unwrap(), data);
    let wire = p::encode(&file).unwrap();
    let (v, n, mut chunks): (u8, [u8; 19], Vec<Vec<u8>>) = p::decode(&wire).unwrap();

    chunks.swap(0, 1);
    let bad = p::decode(&p::encode(&(v, n, &chunks)).unwrap()).unwrap();

    assert!(c::files::decrypt(&k, &bad).is_err());
    chunks.pop();
    let bad = p::decode(&p::encode(&(v, n, &chunks)).unwrap()).unwrap();

    assert!(c::files::decrypt(&k, &bad).is_err());
}

#[test]
fn fixed_ksf_benchmark() {
    let start = std::time::Instant::now();
    let _ = c::backup_key(b"test-password-123", &[2; 16]).unwrap();

    println!("Argon2id 64 MiB t=3 p=1: {:?}", start.elapsed())
}

#[test]
fn every_storable_note_size_seals_within_the_body_limit() {
    let id = SigningKey::generate(&mut OsRng);
    let device = SigningKey::generate(&mut OsRng);
    let k = c::key();
    let account = Uuid::new_v4();

    for size in [5_111_805, 6_600_000, c::MAX_PLAIN] {
        let h = header();
        let cert = c::certify(&id, account, h.device, device.verifying_key().to_bytes()).unwrap();
        let expected = Expected {
            account,
            space: h.space,
            doc: h.doc,
            epoch: 1,
            counter: 1,
            previous: [0; 32],
        };

        let data = vec![7; size];
        let e = c::seal(&k, &device, h, &data).unwrap();

        assert!(e.body.len() <= p::MAX_BODY);
        let plain = c::open(&e, &k, &id.verifying_key(), &cert, &expected).unwrap();

        assert_eq!(plain.len(), size);
    }

    assert!(c::seal(&k, &device, header(), &vec![7; c::MAX_PLAIN + 1]).is_err());
}

#[test]
fn an_envelope_verifies_only_under_its_own_device_key() {
    let device = SigningKey::generate(&mut OsRng);
    let other = SigningKey::generate(&mut OsRng);
    let envelope = c::seal(&c::key(), &device, header(), b"Inhalt").unwrap();

    assert!(c::verify_envelope(&envelope, &device.verifying_key()).is_ok());
    assert!(c::verify_envelope(&envelope, &other.verifying_key()).is_err());

    let mut forged = envelope.clone();

    forged.body[0] ^= 1;
    assert!(c::verify_envelope(&forged, &device.verifying_key()).is_err());

    let mut moved = envelope;

    moved.header.counter += 1;
    assert!(c::verify_envelope(&moved, &device.verifying_key()).is_err());
}
