use std::ffi::{CString, c_char};

unsafe extern "C" {
    fn kladde_open_source(address: *const c_char);
}

const MAX_ADDRESS_LENGTH: usize = 2048;
const INVALID_ADDRESS: &str = "Invalid source URL";
const MAILBOX_SYMBOLS: [char; 4] = ['.', '_', '+', '-'];
const DOMAIN_SYMBOLS: [char; 1] = ['-'];

fn is_web_page(url: &url::Url) -> bool {
    matches!(url.scheme(), "https" | "http")
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn is_plain(part: &str, symbols: &[char]) -> bool {
    !part.is_empty()
        && part
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || symbols.contains(&character))
}

fn is_mail_domain(domain: &str) -> bool {
    domain.contains('.')
        && domain
            .split('.')
            .all(|label| is_plain(label, &DOMAIN_SYMBOLS))
}

fn mail_recipient(url: &url::Url) -> Option<String> {
    if url.scheme() != "mailto" {
        return None;
    }

    let (mailbox, domain) = url.path().split_once('@')?;

    if !is_plain(mailbox, &MAILBOX_SYMBOLS) || !is_mail_domain(domain) {
        return None;
    }

    Some(format!("mailto:{mailbox}@{domain}"))
}

fn openable_address(url: &url::Url) -> Option<String> {
    if is_web_page(url) {
        return Some(url.as_str().to_owned());
    }

    mail_recipient(url)
}

#[tauri::command]
pub fn open_web_source(address: String) -> Result<(), String> {
    if address.len() > MAX_ADDRESS_LENGTH || address.chars().any(char::is_control) {
        return Err(INVALID_ADDRESS.into());
    }

    let url = url::Url::parse(&address).map_err(|_| INVALID_ADDRESS)?;
    let target = openable_address(&url).ok_or(INVALID_ADDRESS)?;
    let address = CString::new(target).map_err(|_| INVALID_ADDRESS)?;

    unsafe { kladde_open_source(address.as_ptr()) };

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opened(address: &str) -> Option<String> {
        openable_address(&url::Url::parse(address).ok()?)
    }

    #[test]
    fn keeps_web_pages_as_they_are() {
        assert_eq!(
            opened("https://example.org/a?b=c#d").as_deref(),
            Some("https://example.org/a?b=c#d")
        );
    }

    #[test]
    fn refuses_credentials_and_other_schemes() {
        for address in [
            "https://user:secret@example.org",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "ftp://example.org",
            "kladde:3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f",
        ] {
            assert_eq!(opened(address), None, "{address}");
        }
    }

    #[test]
    fn writes_mail_to_one_recipient_without_parameters() {
        assert_eq!(
            opened("mailto:someone@example.org").as_deref(),
            Some("mailto:someone@example.org")
        );
        assert_eq!(
            opened("mailto:some.one+notes@mail.example.org?subject=Hi&attach=/etc/passwd&bcc=x@example.org#top")
                .as_deref(),
            Some("mailto:some.one+notes@mail.example.org")
        );
    }

    #[test]
    fn refuses_several_or_disguised_recipients() {
        for address in [
            "mailto:a@example.org,b@example.org",
            "mailto:a@example.org;b@example.org",
            "mailto:a@b@example.org",
            "mailto:someone%40example.org",
            "mailto:someone@exa%20mple.org",
            "mailto:someone@localhost",
            "mailto:someone@example.org.",
            "mailto:?to=someone@example.org",
        ] {
            assert_eq!(opened(address), None, "{address}");
        }
    }

    #[test]
    fn refuses_control_characters_and_overlong_addresses() {
        assert!(open_web_source("https://example.org/\u{7}".into()).is_err());
        assert!(
            open_web_source(format!(
                "https://example.org/{}",
                "a".repeat(MAX_ADDRESS_LENGTH)
            ))
            .is_err()
        );
    }
}
