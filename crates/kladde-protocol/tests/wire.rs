use kladde_protocol::{Client, Envelope, Header, Kind, Server, compat, encode, packet, unpack};
use uuid::Uuid;

fn id(n: u8) -> Uuid {
    Uuid::from_bytes([n, 0, 0, 0, 0, 0, 0x40, 0, 0x80, 0, 0, 0, 0, 0, 0, n])
}

fn header(version: u8, kind: Kind) -> Header {
    Header {
        version,
        kind,
        space: id(1),
        doc: id(2),
        epoch: 3,
        snapshot: id(4),
        device: id(5),
        counter: 6,
        previous: [7; 32],
        nonce: [8; 24],
    }
}

fn envelope(version: u8) -> Envelope {
    Envelope {
        header: header(version, Kind::Update),
        body: vec![9; 20],
        signature: vec![10; 64],
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn tag<T: serde::Serialize>(value: &T) -> u8 {
    encode(value).unwrap()[0]
}

#[test]
fn client_messages_keep_their_numbers() {
    let doc = id(2);
    let tags = [
        tag(&Client::Subscribe {
            space: doc,
            doc,
            last_seq: 0,
            known_snapshot: None,
        }),
        tag(&Client::PushUpdate(envelope(1))),
        tag(&Client::PushSnapshot {
            envelope: envelope(1),
            parent: None,
            covers: 0,
        }),
        tag(&Client::Ephemeral(envelope(1))),
        tag(&Client::Watch { space: doc }),
    ];

    assert_eq!(tags, [0, 1, 2, 3, 4]);
}

#[test]
fn server_messages_keep_their_numbers() {
    let doc = id(2);
    let certificate = kladde_protocol::Certificate {
        version: 1,
        account: doc,
        device: doc,
        public: [0; 32],
        signature: vec![0; 64],
    };

    let tags = [
        tag(&Server::Ack { doc, seq: 1 }),
        tag(&Server::Item {
            seq: 1,
            envelope: envelope(1),
            certificate,
        }),
        tag(&Server::Head { doc, seq: 1 }),
        tag(&Server::Ephemeral(envelope(1))),
        tag(&Server::Conflict),
        tag(&Server::Changed {
            space: doc,
            doc,
            seq: 1,
        }),
        tag(&Server::Removed { space: doc, doc }),
        tag(&Server::Watching { space: doc }),
        tag(&Server::Full),
        tag(&Server::Outdated { doc }),
    ];

    assert_eq!(tags, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
}

#[test]
fn envelope_kinds_keep_their_numbers() {
    let kinds = [
        Kind::Snapshot,
        Kind::Update,
        Kind::Ephemeral,
        Kind::Checkpoint,
    ];

    assert_eq!(kinds.map(|kind| tag(&kind)), [0, 1, 2, 3]);
}

#[test]
fn the_header_layout_is_frozen() {
    assert_eq!(
        hex(&encode(&header(1, Kind::Update)).unwrap()),
        GOLDEN_HEADER
    );
}

#[test]
fn frames_start_with_the_wire_version() {
    let frame = packet(&Server::Conflict).unwrap();

    assert_eq!(frame[0], kladde_protocol::VERSION);
    let mut newer = frame.clone();

    newer[0] = kladde_protocol::VERSION + 1;
    assert!(unpack::<Server>(&newer).is_err());
    assert!(matches!(unpack::<Server>(&frame), Ok(Server::Conflict)));
}

#[test]
fn envelopes_of_later_formats_pass_the_relay_check() {
    assert!(envelope(1).validate().is_ok());
    assert!(envelope(compat::FORMAT + 1).validate().is_ok());
    assert!(envelope(0).validate().is_err());
}

#[test]
fn peers_only_receive_formats_they_read() {
    let peer = compat::Peer::legacy();

    assert!(peer.reads(&header(compat::LEGACY_FORMAT, Kind::Update)));
    assert!(!peer.reads(&header(compat::LEGACY_FORMAT + 1, Kind::Update)));
}

const GOLDEN_HEADER: &str = concat!(
    "0101100100000000004000800000000000000110020000000000400080000000",
    "0000000203100400000000004000800000000000000410050000000000400080",
    "0000000000000506070707070707070707070707070707070707070707070707",
    "0707070707070707080808080808080808080808080808080808080808080808",
);
