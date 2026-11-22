use ed25519_dalek::SigningKey;
use kladde_crypto as crypto;
use kladde_protocol::{Client, Envelope};
use kladde_sync::{Cursor, account::Access};
use proptest::prelude::*;
use uuid::Uuid;
use yrs::{Doc, GetString, ReadTxn, StateVector, Text, Transact, Update, updates::decoder::Decode};

fn sender() -> Access {
    let identity = SigningKey::from_bytes(&[17; 32]);
    let device = SigningKey::from_bytes(&[23; 32]);
    let account = Uuid::new_v4();
    let cert = crypto::certify(
        &identity,
        account,
        Uuid::new_v4(),
        device.verifying_key().to_bytes(),
    )
    .unwrap();
    let mut access = Access {
        origin: String::new(),
        username: String::new(),
        token: String::new(),
        account,
        space: Uuid::new_v4(),
        master: [1; 32],
        workspace: vec![],
        identity: identity.verifying_key().to_bytes(),
        device_key: device.to_bytes(),
        cert,
    };

    access.use_keyset(&[2; 32]).unwrap();

    access
}

fn envelope(request: Client) -> Envelope {
    match request {
        Client::PushUpdate(e) | Client::PushSnapshot { envelope: e, .. } => e,
        _ => panic!("unexpected request"),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(12))]
    #[test]
    fn replay_gaps_reordering_and_restart(letters in proptest::collection::vec(97u8..=122,3..18)) {
        let author=sender();
        let id=Uuid::new_v4();
        let a=Doc::new();
        let b=Doc::new();
        let text=a.get_or_insert_text("body");
        let copy=b.get_or_insert_text("body");
        let mut sending=Cursor::default();
        let mut history=vec![];

        for ch in letters {
            text.insert(&mut a.transact_mut(),0,&char::from(ch).to_string());
            let update=a.transact().encode_state_as_update_v1(&StateVector::default());
            let e=envelope(sending.push(&author,id,&update).unwrap());

            sending.accept(&author,id,sending.seq+1,&e,&author.cert).unwrap();
            history.push(e);
        }

        let mut receiving=Cursor::default();

        for (index,e) in history.iter().enumerate() {
            let seq=index as i64+1;

            prop_assert!(receiving.accept(&author,id,seq+1,e,&author.cert).is_err());

            if let Some(next)=history.get(index+1){prop_assert!(receiving.accept(&author,id,seq,next,&author.cert).is_err())}
            let mut corrupted=e.clone();

            corrupted.body[0]^=1;
            prop_assert!(receiving.accept(&author,id,seq,&corrupted,&author.cert).is_err());

            if index>0{prop_assert!(receiving.accept(&author,id,seq,&history[0],&author.cert).is_err())}
            prop_assert_eq!(receiving.seq,seq-1);
            let data=receiving.accept(&author,id,seq,e,&author.cert).unwrap();

            b.transact_mut().apply_update(Update::decode_v1(&data).unwrap()).unwrap();
            prop_assert!(receiving.accept(&author,id,seq,e,&author.cert).is_err());
            receiving=serde_json::from_slice(&serde_json::to_vec(&receiving).unwrap()).unwrap();
        }

        prop_assert_eq!(copy.get_string(&b.transact()),text.get_string(&a.transact()));
    }
}
