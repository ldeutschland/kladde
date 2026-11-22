use kladde_clip::{Error, public_address, source_address};

const MAX_ADDRESS: usize = 2048;

fn refused(address: &str) -> bool {
    matches!(public_address(address), Err(Error::Address))
}

#[test]
fn encoded_loopback_and_private_ipv4_hosts_are_refused() {
    for address in [
        "https://127.1/",
        "https://127.0.0.1./",
        "https://0177.0.0.1/",
        "https://0x7f000001/",
        "https://017700000001/",
        "https://%31%32%37.0.0.1/",
        "https://\u{ff11}\u{ff12}\u{ff17}.\u{ff10}.\u{ff10}.\u{ff11}/",
        "https://167772161/",
        "https://3232235777/",
        "https://2852039166/",
        "https://0/",
    ] {
        assert!(refused(address), "{address}");
    }
}

#[test]
fn reserved_ipv4_ranges_are_refused() {
    for address in [
        "https://100.127.255.255/",
        "https://192.0.0.8/",
        "https://192.0.2.1/",
        "https://198.18.0.1/",
        "https://198.19.255.255/",
        "https://198.51.100.7/",
        "https://203.0.113.9/",
        "https://224.0.0.1/",
        "https://240.0.0.1/",
        "https://255.255.255.255/",
    ] {
        assert!(refused(address), "{address}");
    }
}

#[test]
fn neighbours_of_reserved_ranges_stay_public() {
    for address in [
        "https://100.63.255.255/",
        "https://100.128.0.0/",
        "https://172.15.255.255/",
        "https://172.32.0.1/",
        "https://198.17.255.255/",
        "https://198.20.0.1/",
        "https://1.1.1.1/",
    ] {
        assert!(public_address(address).is_ok(), "{address}");
    }
}

#[test]
fn ipv6_hosts_hiding_private_ipv4_are_refused() {
    for address in [
        "https://[::ffff:7f00:1]/",
        "https://[::ffff:169.254.169.254]/",
        "https://[::ffff:192.168.0.1]/",
        "https://[::127.0.0.1]/",
        "https://[::10.0.0.1]/",
        "https://[64:ff9b::7f00:1]/",
        "https://[64:ff9b::192.168.1.1]/",
        "https://[2002:a9fe:a9fe::1]/",
        "https://[2002:c0a8:0101::]/",
        "https://[0:0:0:0:0:ffff:127.0.0.1]/",
    ] {
        assert!(refused(address), "{address}");
    }
}

#[test]
fn non_global_ipv6_hosts_are_refused() {
    for address in [
        "https://[fc00::1]/",
        "https://[fdff:ffff::1]/",
        "https://[fe80::1%25en0]/",
        "https://[febf::1]/",
        "https://[ff02::1]/",
        "https://[2001::1]/",
        "https://[2001:0:4136:e378::1]/",
        "https://[2001:db8:ffff::1]/",
        "https://[100::1]/",
        "https://[::ffff:0:7f00:1]/",
    ] {
        assert!(refused(address), "{address}");
    }
}

#[test]
fn ipv6_hosts_embedding_public_ipv4_are_allowed() {
    for address in [
        "https://[::ffff:1.1.1.1]/",
        "https://[64:ff9b::101:101]/",
        "https://[2002:101:101::1]/",
        "https://[2a00:1450:4001:82a::200e]/",
    ] {
        assert!(public_address(address).is_ok(), "{address}");
    }
}

#[test]
fn single_label_and_local_names_are_refused() {
    for address in [
        "https://intranet/",
        "https://LOCALHOST/",
        "https://LocalHost./",
        "https://api.localhost/",
        "https://Printer.LOCAL./",
        "https://router.home.arpa/",
        "https://metadata.google.internal/",
        "https://metadata.google.internal./",
    ] {
        assert!(refused(address), "{address}");
    }
}

#[test]
fn credentials_hidden_in_the_address_are_refused() {
    for address in [
        "https://example.com@127.0.0.1/",
        "https://user@example.com/",
        "https://:secret@example.com/",
        "https://user:@example.com/",
        "example.com@10.0.0.1",
    ] {
        assert!(refused(address), "{address}");
    }
}

#[test]
fn fragments_and_backslashes_cannot_change_the_target_host() {
    assert!(refused("https://127.0.0.1#@example.com/"));
    assert!(refused("https://127.0.0.1?@example.com/"));
    assert_eq!(
        public_address("https://example.com\\@127.0.0.1/").unwrap(),
        "https://example.com/@127.0.0.1/"
    );
}

#[test]
fn only_web_schemes_are_accepted() {
    for address in [
        "ftp://example.com/",
        "ws://example.com/",
        "wss://example.com/",
        "gopher://example.com/",
        "javascript://example.com/%0aalert(1)",
        "data://example.com/",
        "blob:https://example.com/uuid",
        "about:blank",
        "mailto:a@example.com",
        "https:example.com",
        "view-source:https://example.com/",
    ] {
        assert!(refused(address), "{address}");
    }
}

#[test]
fn http_and_explicit_default_ports_are_normalised_to_https() {
    assert_eq!(
        public_address("HTTP://Example.COM/Pfad").unwrap(),
        "https://example.com/Pfad"
    );
    assert_eq!(
        public_address("  https://example.com:443/x  ").unwrap(),
        "https://example.com/x"
    );
    assert_eq!(
        public_address("http://example.com:443/").unwrap(),
        "https://example.com/"
    );
    assert!(refused("https://example.com:80/"));
    assert!(refused("https://example.com:0/"));
}

#[test]
fn control_and_invisible_characters_are_refused() {
    for address in [
        "https://example.com/\u{0}",
        "https://exa\tmple.com/",
        "https://example.com/\r\nHost: 127.0.0.1",
        "https://example.com/\u{7f}",
        "https://exa\u{202e}mple.com/",
    ] {
        assert!(refused(address), "{address:?}");
    }

    assert_eq!(
        public_address("https://exa\u{200b}mple.com/").unwrap(),
        "https://example.com/"
    );
}

#[test]
fn overlong_addresses_are_refused_even_after_encoding() {
    let at_limit = format!("https://example.com/{}", "a".repeat(MAX_ADDRESS - 20));

    assert_eq!(at_limit.len(), MAX_ADDRESS);
    assert!(public_address(&at_limit).is_ok());
    assert!(source_address(&at_limit).is_ok());
    let expanding = format!("https://example.com/{}", "ä".repeat(500));

    assert!(expanding.len() <= MAX_ADDRESS);
    assert!(refused(&expanding));
    assert!(source_address(&expanding).is_err());
    assert!(refused(&format!("{}.com", "a".repeat(MAX_ADDRESS))));
}

#[test]
fn source_addresses_allow_private_pages_but_no_other_schemes() {
    assert_eq!(
        source_address("http://127.0.0.1:3000/a").unwrap(),
        "http://127.0.0.1:3000/a"
    );
    assert_eq!(
        source_address(" https://[::1]/ ").unwrap(),
        "https://[::1]/"
    );

    for address in [
        "ftp://example.com/",
        "ws://example.com/",
        "about:blank",
        "blob:https://example.com/uuid",
        "https://example.com@127.0.0.1/",
        "http://:pw@example.com/",
        "https://exa\u{7}mple.com/",
    ] {
        assert!(
            matches!(source_address(address), Err(Error::Address)),
            "{address:?}"
        );
    }
}
