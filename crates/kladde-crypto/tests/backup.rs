use kladde_crypto::{
    backup::{Opener, Sealer},
    key,
};

use uuid::Uuid;

fn pair(space: Uuid, context: &[u8]) -> (Sealer, Opener) {
    let (secret, nonce) = (key(), [3; 19]);
    let sealer = Sealer::new(&secret, space, &nonce, context.to_vec()).unwrap();
    let opener = Opener::new(&secret, space, &nonce, context.to_vec()).unwrap();

    (sealer, opener)
}

#[test]
fn parts_open_in_order_and_the_last_one_ends_the_stream() {
    let (mut sealer, mut opener) = pair(Uuid::new_v4(), b"kopf");
    let first = sealer.next(b"eins").unwrap();
    let second = sealer.last(b"zwei").unwrap();

    assert_eq!(opener.next(&first).unwrap().as_slice(), b"eins");
    assert_eq!(opener.last(&second).unwrap().as_slice(), b"zwei");
}

#[test]
fn reordered_shortened_and_foreign_parts_are_refused() {
    let space = Uuid::new_v4();
    let (mut sealer, mut opener) = pair(space, b"kopf");
    let first = sealer.next(b"eins").unwrap();
    let second = sealer.next(b"zwei").unwrap();

    assert!(opener.next(&second).is_err());
    let (_, shortened) = pair(space, b"kopf");

    assert!(shortened.last(&first).is_err());
    let (mut other, _) = pair(space, b"anderer kopf");
    let foreign = other.next(b"eins").unwrap();
    let (_, mut opener) = pair(space, b"kopf");

    assert!(opener.next(&foreign).is_err());
}
