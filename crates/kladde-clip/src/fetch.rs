use crate::{Error, address};
use futures_util::StreamExt;
use reqwest::{
    Client,
    dns::{Addrs, Name, Resolve, Resolving},
    header::{ACCEPT, CONTENT_TYPE},
    redirect::Policy,
};

use std::{net::SocketAddr, sync::Arc, time::Duration};
use url::Url;

const MAX_REDIRECTS: usize = 3;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str = "Mozilla/5.0 (compatible; KladdeClipper/1.0)";
const CHARSET_SNIFF_BYTES: usize = 2048;
const SINGLE_BYTE_CHARSETS: &[&str] =
    &["iso-8859-1", "latin1", "windows-1252", "cp1252", "us-ascii"];
const WINDOWS_1252_START: u8 = 0x80;
const WINDOWS_1252_HIGH: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}',
    '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
];

struct PublicResolver;

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();

        Box::pin(async move {
            let found = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let public: Vec<SocketAddr> = found.filter(|a| address::public(a.ip())).collect();

            if public.is_empty() {
                return Err(Box::new(Error::Address) as Box<dyn std::error::Error + Send + Sync>);
            }

            Ok(Box::new(public.into_iter()) as Addrs)
        })
    }
}

pub struct Fetched {
    pub url: Url,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub fn client() -> Result<Client, Error> {
    Client::builder()
        .https_only(true)
        .no_proxy()
        .referer(false)
        .dns_resolver(Arc::new(PublicResolver))
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS || address::check(attempt.url()).is_err() {
                attempt.error(Error::Address)
            } else {
                attempt.follow()
            }
        }))
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|_| Error::Network)
}

pub async fn get(client: &Client, url: Url, accept: &str, limit: usize) -> Result<Fetched, Error> {
    address::check(&url)?;
    let response = client
        .get(url)
        .header(ACCEPT, accept)
        .send()
        .await
        .map_err(|_| Error::Network)?;
    if !response.status().is_success() {
        return Err(Error::Status(response.status().as_u16()));
    }

    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(Error::TooLarge);
    }

    let url = response.url().clone();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();

    while let Some(part) = stream.next().await {
        let part = part.map_err(|_| Error::Network)?;

        if bytes.len() + part.len() > limit {
            return Err(Error::TooLarge);
        }

        bytes.extend_from_slice(&part);
    }

    Ok(Fetched {
        url,
        content_type,
        bytes,
    })
}

pub fn decode(bytes: &[u8], content_type: &str) -> String {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(CHARSET_SNIFF_BYTES)])
        .to_ascii_lowercase();
    let declared = charset(content_type).or_else(|| charset(&head));

    if declared.is_some_and(|name| SINGLE_BYTE_CHARSETS.contains(&name.as_str())) {
        return bytes.iter().map(|&byte| windows_1252(byte)).collect();
    }

    String::from_utf8_lossy(bytes).into_owned()
}

fn windows_1252(byte: u8) -> char {
    match byte.checked_sub(WINDOWS_1252_START) {
        Some(offset) if usize::from(offset) < WINDOWS_1252_HIGH.len() => {
            WINDOWS_1252_HIGH[usize::from(offset)]
        }
        _ => byte as char,
    }
}

fn charset(text: &str) -> Option<String> {
    let start = text.find("charset=")? + "charset=".len();
    let name: String = text[start..]
        .trim_start_matches(['"', '\''])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if name.is_empty() { None } else { Some(name) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_declared_latin1_and_defaults_to_utf8() {
        assert_eq!(
            decode(&[0x47, 0x72, 0xfc, 0xdf], "text/html; charset=iso-8859-1"),
            "Grüß"
        );
        assert_eq!(
            decode(b"<meta charset=\"windows-1252\"><p>\xe9</p>", "text/html"),
            "<meta charset=\"windows-1252\"><p>é</p>"
        );
        assert_eq!(decode("Grüß".as_bytes(), "text/html"), "Grüß");
        assert_eq!(
            decode(
                b"\x84Preis\x93 \x96 5\x80\x85",
                "text/html; charset=windows-1252"
            ),
            "„Preis“ – 5€…"
        );
        assert_eq!(
            decode(&[0xff, 0x41], "text/html; charset=utf-8"),
            "\u{fffd}A"
        );
    }

    #[test]
    fn rejects_private_targets_before_connecting() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let blocked = runtime.block_on(async {
            let client = client().unwrap();

            get(
                &client,
                Url::parse("https://127.0.0.1/").unwrap(),
                "text/html",
                10,
            )
            .await
        });

        assert!(matches!(blocked, Err(Error::Address)));
    }
}
