#![no_main]
use libfuzzer_sys::fuzz_target;
use yrs::{Doc, Transact, Update};

fuzz_target!(|data: &[u8]| {
    if data.len() >= 65536 {
        return;
    }

    if let Ok(update) = Update::decode_complete_v1(data) {
        let doc = Doc::new();
        let _ = doc.transact_mut().apply_update(update);
    }
});
