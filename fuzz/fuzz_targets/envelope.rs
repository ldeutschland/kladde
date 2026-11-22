#![no_main]
use kladde_protocol::Envelope;
use libfuzzer_sys::fuzz_target;

fuzz_target!(
    |data: &[u8]| if let Ok(envelope) = kladde_protocol::decode::<Envelope>(data) {
        let _ = envelope.validate();
    }
);
