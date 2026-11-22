use kladde_protocol::{
    Client, Envelope, Header, Kind, MAX_BODY, MAX_ENCODED_ATTACHMENT, MAX_WIRE, Server, VERSION,
    account, decode, decode_attachment, encode, packet, unpack,
};

use serde_bytes::ByteBuf;
use uuid::Uuid;

fn envelope() -> Envelope {
    Envelope {
        header: Header {
            version: 1,
            kind: Kind::Update,
            space: Uuid::new_v4(),
            doc: Uuid::new_v4(),
            epoch: 1,
            snapshot: Uuid::new_v4(),
            device: Uuid::new_v4(),
            counter: 1,
            previous: [0; 32],
            nonce: [1; 24],
        },
        body: vec![2; 20],
        signature: vec![3; 64],
    }
}

fn subscribe() -> Client {
    Client::Subscribe {
        space: Uuid::new_v4(),
        doc: Uuid::new_v4(),
        last_seq: 5,
        known_snapshot: None,
    }
}

#[test]
fn empty_truncated_and_padded_messages_are_refused() {
    let wire = encode(&Client::PushUpdate(envelope())).unwrap();

    assert!(decode::<Client>(&[]).is_err());

    for length in 0..wire.len() {
        assert!(
            decode::<Client>(&wire[..length]).is_err(),
            "length {length}"
        );
    }

    let mut padded = wire.clone();

    padded.push(0);
    assert!(decode::<Client>(&padded).is_err());
    assert!(decode::<Client>(&wire).is_ok());
}

#[test]
fn non_canonical_encodings_are_refused() {
    assert!(decode::<u32>(&[0x81, 0x00]).is_err());
    assert_eq!(decode::<u32>(&[0x01]).unwrap(), 1);
    assert!(decode::<bool>(&[2]).is_err());
    let mut wire = encode(&subscribe()).unwrap();
    let option_tag = wire.len() - 1;

    assert_eq!(wire[option_tag], 0);
    wire[option_tag] = 2;
    assert!(decode::<Client>(&wire).is_err());
}

#[test]
fn unknown_variants_and_wrong_uuid_lengths_are_refused() {
    assert!(decode::<Client>(&[5]).is_err());
    assert!(decode::<Server>(&[10]).is_err());
    assert!(decode::<Kind>(&[4]).is_err());
    let mut wire = encode(&Client::Watch {
        space: Uuid::new_v4(),
    })
    .unwrap();

    assert_eq!(wire[1], 16);
    wire[1] = 15;
    wire.pop();
    assert!(decode::<Client>(&wire).is_err());
}

#[test]
fn length_prefixes_larger_than_the_message_are_refused() {
    let mut wire = encode(&ByteBuf::from(vec![1u8; 4])).unwrap();

    wire.splice(..1, [0xff, 0xff, 0xff, 0xff, 0x0f]);
    assert!(decode::<ByteBuf>(&wire).is_err());
    assert!(decode::<Vec<Uuid>>(&[0xff, 0xff, 0xff, 0xff, 0x0f]).is_err());
}

#[test]
fn messages_beyond_their_size_limit_are_refused() {
    let frame_sized = encode(&ByteBuf::from(vec![0u8; MAX_WIRE])).unwrap();

    assert!(frame_sized.len() > MAX_WIRE);
    assert!(decode::<ByteBuf>(&frame_sized).is_err());
    assert!(decode_attachment::<ByteBuf>(&frame_sized).is_ok());
    let attachment_sized = encode(&ByteBuf::from(vec![0u8; MAX_ENCODED_ATTACHMENT])).unwrap();

    assert!(decode_attachment::<ByteBuf>(&attachment_sized).is_err());
    let mut oversized = envelope();

    oversized.body = vec![0; MAX_WIRE];
    assert!(packet(&Client::PushUpdate(oversized)).is_err());
}

#[test]
fn frames_need_the_current_version_byte_and_a_message() {
    let frame = packet(&subscribe()).unwrap();

    assert!(unpack::<Client>(&[]).is_err());
    assert!(unpack::<Client>(&[VERSION]).is_err());
    let mut unversioned = frame.clone();

    unversioned[0] = 0;
    assert!(unpack::<Client>(&unversioned).is_err());
    assert!(unpack::<Client>(&frame[1..]).is_err());
    assert!(matches!(
        unpack::<Client>(&frame),
        Ok(Client::Subscribe { last_seq: 5, .. })
    ));
}

#[test]
fn envelope_validation_checks_every_bound() {
    let at_limits = Envelope {
        body: vec![0; MAX_BODY],
        ..envelope()
    };

    assert!(at_limits.validate().is_ok());
    let changes: [fn(&mut Envelope); 9] = [
        |e| e.header.epoch = 0,
        |e| e.header.counter = 0,
        |e| e.body.truncate(19),
        |e| e.body = vec![0; MAX_BODY + 1],
        |e| e.signature.truncate(63),
        |e| e.signature.push(0),
        |e| e.header.space = Uuid::nil(),
        |e| e.header.doc = Uuid::from_u128(u128::MAX),
        |e| e.header.device = Uuid::from_u128(0x0000_0000_0000_7000_8000_0000_0000_0001),
    ];

    for (index, change) in changes.iter().enumerate() {
        let mut broken = envelope();

        change(&mut broken);
        assert!(broken.validate().is_err(), "change {index}");
    }

    let mut snapshot_v1 = envelope();

    snapshot_v1.header.snapshot = Uuid::from_bytes([1; 16]);
    assert!(snapshot_v1.validate().is_err());
}

#[test]
fn signed_relay_messages_are_frozen_and_domain_separated() {
    let [a, b, c] = [1u8, 2, 3].map(|n| Uuid::from_bytes([n; 16]));
    let mut expected = b"kladde/v1/purge".to_vec();

    for id in [a, b, c] {
        expected.push(16);
        expected.extend_from_slice(id.as_bytes());
    }

    assert_eq!(account::purge_message(a, b, c).unwrap(), expected);
    let messages = [
        account::purge_message(a, b, c).unwrap(),
        account::erase_blob_message(a, b, c).unwrap(),
        account::discard_message(a, b, c, &[]).unwrap(),
        account::discard_message(a, b, c, &[a]).unwrap(),
        account::space_key_message(a, b, c.as_bytes()).unwrap(),
        account::recovery_keys_message(a, b).unwrap(),
        account::renew_message(a, b).unwrap(),
    ];

    for (left, first) in messages.iter().enumerate() {
        for second in &messages[left + 1..] {
            assert_ne!(first, second);
        }
    }

    assert_ne!(
        account::discard_message(a, b, c, &[a, b]).unwrap(),
        account::discard_message(a, b, c, &[b, a]).unwrap()
    );
    assert_ne!(
        account::space_key_message(a, b, b"x").unwrap(),
        account::space_key_message(a, b, b"y").unwrap()
    );
}
