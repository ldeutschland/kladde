#![no_main]
use kladde_protocol::compat;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = kladde_protocol::unpack::<kladde_protocol::Client>(data);
    let _ = kladde_protocol::unpack::<kladde_protocol::Server>(data);
    let _ = kladde_protocol::decode::<kladde_protocol::Checkpoint>(data);

    if let Ok(text) = std::str::from_utf8(data) {
        let mut parts = text.splitn(3, '\n');
        let _ = compat::Peer::admit(parts.next(), parts.next(), parts.next());
    }
});
