use crate::Error;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use url::{Host, Url};

pub const MAX_ADDRESS: usize = 2048;
const BLOCKED_SUFFIXES: &[&str] = &[".localhost", ".local", ".internal", ".home.arpa"];

fn well_formed(input: &str) -> bool {
    !input.is_empty() && input.len() <= MAX_ADDRESS && !input.chars().any(char::is_control)
}

pub fn parse(input: &str) -> Result<Url, Error> {
    let input = input.trim();

    if !well_formed(input) {
        return Err(Error::Address);
    }

    let full = if input.contains("://") {
        input.to_string()
    } else {
        format!("https://{input}")
    };

    let mut url = Url::parse(&full).map_err(|_| Error::Address)?;

    if url.scheme() == "http" {
        url.set_scheme("https").map_err(|_| Error::Address)?;
    }

    check(&url)?;

    Ok(url)
}

pub fn source(input: &str) -> Result<Url, Error> {
    let input = input.trim();

    if !well_formed(input) {
        return Err(Error::Address);
    }

    let url = Url::parse(input).map_err(|_| Error::Address)?;
    let valid = matches!(url.scheme(), "https" | "http")
        && url.username().is_empty()
        && url.password().is_none()
        && url.host().is_some()
        && url.as_str().len() <= MAX_ADDRESS;
    if valid { Ok(url) } else { Err(Error::Address) }
}

pub fn check(url: &Url) -> Result<(), Error> {
    let shape_valid = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.as_str().len() <= MAX_ADDRESS;
    if !shape_valid {
        return Err(Error::Address);
    }

    let host_allowed = match url.host() {
        Some(Host::Domain(domain)) => public_domain(domain),
        Some(Host::Ipv4(ip)) => public(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => public(IpAddr::V6(ip)),
        None => false,
    };

    if host_allowed {
        Ok(())
    } else {
        Err(Error::Address)
    }
}

fn public_domain(domain: &str) -> bool {
    let domain = domain.trim_end_matches('.').to_ascii_lowercase();

    domain.contains('.')
        && domain != "localhost"
        && !BLOCKED_SUFFIXES
            .iter()
            .any(|suffix| domain.ends_with(suffix))
}

pub fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => public_v6(v6),
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    let reserved = ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || a == 0
        || a >= 240
        || (a == 100 && (64..128).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (b == 18 || b == 19));
    !reserved
}

fn public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = embedded_v4(ip) {
        return public_v4(v4);
    }

    let segments = ip.segments();
    let global_unicast = (segments[0] & 0xe000) == 0x2000;
    let documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
    let teredo = segments[0] == 0x2001 && segments[1] == 0;

    global_unicast && !documentation && !teredo
}

fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let segments = ip.segments();
    let tail = Ipv4Addr::new(
        (segments[6] >> 8) as u8,
        segments[6] as u8,
        (segments[7] >> 8) as u8,
        segments[7] as u8,
    );
    let mapped = segments[..5] == [0; 5] && segments[5] == 0xffff;
    let compatible = segments[..6] == [0; 6] && !ip.is_loopback() && !ip.is_unspecified();
    let nat64 = segments[0] == 0x64 && segments[1] == 0xff9b && segments[2..6] == [0; 4];

    if mapped || compatible || nat64 {
        return Some(tail);
    }

    if segments[0] == 0x2002 {
        return Some(Ipv4Addr::new(
            (segments[1] >> 8) as u8,
            segments[1] as u8,
            (segments[2] >> 8) as u8,
            segments[2] as u8,
        ));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_accepts_any_web_page_without_credentials() {
        assert_eq!(
            source("http://intranet.local/a").unwrap().as_str(),
            "http://intranet.local/a"
        );
        assert!(source("https://example.com:8443/x").is_ok());

        for bad in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://user:pw@example.com/",
            "chrome://extensions",
            "data:text/html,x",
            "example.com",
            "",
            "https://example.com/\nx",
        ] {
            assert!(source(bad).is_err(), "{bad}");
        }

        assert!(source(&format!("https://example.com/{}", "a".repeat(MAX_ADDRESS))).is_err());
    }

    #[test]
    fn accepts_public_addresses_and_upgrades_http() {
        assert_eq!(
            parse("example.com/a").unwrap().as_str(),
            "https://example.com/a"
        );
        assert_eq!(
            parse("http://example.com").unwrap().as_str(),
            "https://example.com/"
        );
        assert!(parse("https://93.184.215.14/").is_ok());
        assert!(parse("https://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/").is_ok());
    }

    #[test]
    fn rejects_local_and_reserved_hosts() {
        for address in [
            "localhost",
            "https://localhost./",
            "https://printer.local/",
            "https://db.internal/",
            "https://127.0.0.1/",
            "https://0x7f.1/",
            "https://2130706433/",
            "https://10.0.0.1/",
            "https://172.16.4.1/",
            "https://192.168.1.1/",
            "https://169.254.169.254/latest/meta-data",
            "https://100.64.0.1/",
            "https://0.0.0.0/",
            "https://[::1]/",
            "https://[::]/",
            "https://[::ffff:127.0.0.1]/",
            "https://[::ffff:10.0.0.1]/",
            "https://[64:ff9b::a00:1]/",
            "https://[2002:7f00:1::]/",
            "https://[fe80::1]/",
            "https://[fd00::1]/",
            "https://[2001:db8::1]/",
        ] {
            assert!(parse(address).is_err(), "{address}");
        }
    }

    #[test]
    fn rejects_unsafe_shapes() {
        for address in [
            "",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com/",
            "https://user:secret@example.com/",
            "https://example.com:8443/",
            "http://example.com:8080/",
            "https://exa\nmple.com/",
        ] {
            assert!(parse(address).is_err(), "{address:?}");
        }

        assert!(parse(&format!("https://example.com/{}", "a".repeat(MAX_ADDRESS))).is_err());
    }
}
