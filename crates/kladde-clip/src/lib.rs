mod address;
mod article;
mod fetch;
mod markdown;

use serde::Serialize;

pub use markdown::IMAGE_PLACEHOLDER;

const MAX_PAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const HTML_ACCEPT: &str = "text/html,application/xhtml+xml;q=0.9";
const IMAGE_ACCEPT: &str = "image/avif,image/webp,image/png,image/jpeg,image/gif";
const HTML_TYPES: &[&str] = &["text/html", "application/xhtml+xml"];

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Enter a public https web address")]
    Address,
    #[error("Website unavailable")]
    Network,
    #[error("Website answered with status {0}")]
    Status(u16),
    #[error("Page or image is too large")]
    TooLarge,
    #[error("The address is not a web page")]
    NotHtml,
    #[error("Unsupported image")]
    Image,
    #[error("No readable content found")]
    Empty,
    #[error("Page is too complex to clip")]
    Complex,
}

#[derive(Debug, Serialize)]
pub struct Clip {
    pub url: String,
    pub title: String,
    pub site: String,
    pub byline: String,
    pub published: String,
    pub markdown: String,
    pub images: Vec<String>,
}

#[derive(Clone, Copy)]
pub enum Extract {
    Article,
    Whole,
}

pub struct Image {
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

pub async fn clip(address: &str) -> Result<Clip, Error> {
    let url = address::parse(address)?;
    let fetched = fetch::get(&fetch::client()?, url, HTML_ACCEPT, MAX_PAGE_BYTES).await?;
    let media_type = fetched
        .content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim();
    if !HTML_TYPES.contains(&media_type) {
        return Err(Error::NotHtml);
    }

    let html = fetch::decode(&fetched.bytes, &fetched.content_type);
    let clip = article::read(&html, &fetched.url, Extract::Article)?;

    if clip.markdown.trim().is_empty() {
        return Err(Error::Empty);
    }

    Ok(clip)
}

pub fn read_html(html: &str, address: &str, extract: Extract) -> Result<Clip, Error> {
    if html.len() > MAX_PAGE_BYTES {
        return Err(Error::TooLarge);
    }

    let url = address::source(address)?;
    let clip = article::read(html, &url, extract)?;

    if clip.markdown.trim().is_empty() {
        return Err(Error::Empty);
    }

    Ok(clip)
}

pub fn picture(page: &str, title: &str, image: String) -> Result<Clip, Error> {
    Ok(article::picture(&address::source(page)?, title, image))
}

pub fn public_address(input: &str) -> Result<String, Error> {
    address::parse(input).map(String::from)
}

pub fn source_address(input: &str) -> Result<String, Error> {
    address::source(input).map(String::from)
}

pub fn annotate(clip: &mut Clip, note: &str) {
    let quote = note
        .lines()
        .map(|line| markdown::collapse(&markdown::escape(line)))
        .filter(|line| !line.is_empty())
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n>\n");
    if !quote.is_empty() {
        clip.markdown = format!("{quote}\n\n{}", clip.markdown);
    }
}

pub async fn image(address: &str, limit: usize) -> Result<Image, Error> {
    let url = address::parse(address)?;
    let fetched = fetch::get(
        &fetch::client()?,
        url,
        IMAGE_ACCEPT,
        limit.min(MAX_IMAGE_BYTES),
    )
    .await?;
    let mime = image_type(&fetched.bytes).ok_or(Error::Image)?;

    Ok(Image {
        mime,
        bytes: fetched.bytes,
    })
}

pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    let brand = bytes.get(4..12);

    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if brand == Some(b"ftypavif") || brand == Some(b"ftypavis") {
        Some("image/avif")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "<html><head><title>Intern</title></head><body>\
        <p>Nur nach Anmeldung sichtbarer Text, lang genug für die Bewertung.</p></body></html>";

    #[test]
    fn reads_rendered_pages_from_any_web_address() {
        let clip = read_html(PAGE, "http://wiki.intern/seite", Extract::Article).unwrap();

        assert_eq!(clip.url, "http://wiki.intern/seite");
        assert_eq!(clip.title, "Intern");
        assert!(clip.markdown.starts_with("Nur nach Anmeldung"));
    }

    #[test]
    fn rejects_unsafe_sources_and_empty_or_huge_pages() {
        assert!(matches!(
            read_html(PAGE, "file:///etc/hosts", Extract::Whole),
            Err(Error::Address)
        ));
        assert!(matches!(
            read_html(
                "<script>x()</script>",
                "https://example.com",
                Extract::Whole
            ),
            Err(Error::Empty)
        ));
        let huge = "a".repeat(MAX_PAGE_BYTES + 1);

        assert!(matches!(
            read_html(&huge, "https://example.com", Extract::Whole),
            Err(Error::TooLarge)
        ));
    }

    #[test]
    fn notes_become_escaped_quotes() {
        let mut clip = read_html(PAGE, "https://example.com", Extract::Whole).unwrap();

        annotate(
            &mut clip,
            "Wichtig: [klick](javascript:x)\n\n<b>fett</b>\u{202e}",
        );
        assert!(clip.markdown.starts_with(
            "> Wichtig\\: \\[klick\\]\\(javascript\\:x\\)\n>\n> \\<b\\>fett\\<\\/b\\>\n\nNur"
        ));
        let before = clip.markdown.clone();

        annotate(&mut clip, " \n ");
        assert_eq!(clip.markdown, before);
    }

    #[test]
    fn public_address_refuses_private_hosts() {
        assert!(public_address("https://example.com/a.png").is_ok());
        assert!(public_address("https://192.168.1.2/a.png").is_err());
        assert_eq!(
            source_address("http://192.168.1.2/").unwrap(),
            "http://192.168.1.2/"
        );
    }

    #[test]
    fn recognizes_only_raster_images_by_content() {
        assert_eq!(image_type(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(image_type(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(image_type(b"GIF89a.."), Some("image/gif"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_type(b"\0\0\0\x1cftypavif"), Some("image/avif"));
        assert_eq!(image_type(b"<svg onload=alert(1)>"), None);
        assert_eq!(image_type(b"<html>"), None);
        assert_eq!(image_type(b""), None);
    }
}
