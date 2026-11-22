use kladde_clip::{Error, Extract, IMAGE_PLACEHOLDER, annotate, image_type, picture, read_html};

#[test]
fn image_types_need_the_complete_magic_bytes() {
    for truncated in [
        &b"\x89PNG\r\n\x1a"[..],
        &[0xff, 0xd8][..],
        &b"GIF89"[..],
        &b"GIF88a"[..],
        &b"RIFF\0\0\0\0WEB"[..],
        &b"RIFF\0\0\0\0WAVE"[..],
        &b"\0\0\0\x1cftypavi"[..],
        &b"\0\0\0\x1cftypheic"[..],
        &b"\0\0\0\x1cftypmp42"[..],
    ] {
        assert_eq!(image_type(truncated), None, "{truncated:?}");
    }
}

#[test]
fn active_or_vector_content_is_never_an_image() {
    for content in [
        &b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>"[..],
        &b"%PDF-1.7"[..],
        &b"\xef\xbb\xbf<svg>"[..],
        &b" \x89PNG\r\n\x1a\n"[..],
        &b"BM\0\0"[..],
        &b"II*\0"[..],
        &b"\0\0\x01\0"[..],
    ] {
        assert_eq!(image_type(content), None, "{content:?}");
    }
}

#[test]
fn polyglots_are_typed_by_their_leading_signature_only() {
    let mut png_then_html = b"\x89PNG\r\n\x1a\n".to_vec();

    png_then_html.extend_from_slice(b"<script>alert(1)</script>");
    assert_eq!(image_type(&png_then_html), Some("image/png"));
    assert_eq!(image_type(b"\0\0\0\x1cftypavis"), Some("image/avif"));
    assert_eq!(image_type(b"GIF87a"), Some("image/gif"));
}

#[test]
fn notes_are_quoted_line_by_line_with_markup_and_controls_neutralised() {
    let mut clip = read_html("<p>Body</p>", "https://example.com/", Extract::Whole).unwrap();

    annotate(
        &mut clip,
        "# Kopf\r\n\r\n![x](https://evil.example/p.png)\n\u{2066}links\u{2069}\u{0}  zwei   Worte ",
    );
    assert_eq!(
        clip.markdown,
        "> \\# Kopf\n>\n> \\!\\[x\\]\\(https\\:\\/\\/evil\\.example\\/p\\.png\\)\n>\n> links zwei Worte\n\nBody"
    );
}

#[test]
fn notes_stack_in_front_of_earlier_notes() {
    let mut clip = read_html("<p>Body</p>", "https://example.com/", Extract::Whole).unwrap();

    annotate(&mut clip, "erste");
    annotate(&mut clip, "zweite");
    assert_eq!(clip.markdown, "> zweite\n\n> erste\n\nBody");
    annotate(&mut clip, "\u{200b}\u{feff}\u{202e}");
    assert_eq!(clip.markdown, "> zweite\n\n> erste\n\nBody");
}

#[test]
fn pictures_need_a_web_source_page() {
    for page in [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "https://u:p@example.com/",
        "",
    ] {
        assert!(
            matches!(picture(page, "Bild", String::new()), Err(Error::Address)),
            "{page}"
        );
    }
}

#[test]
fn picture_titles_are_cleaned_and_markdown_is_fixed() {
    let title = format!("\u{202e}{}\n", "Bild ".repeat(80));
    let clip = picture(
        "https://www.example.com/galerie",
        &title,
        "https://cdn.example.com/a.png".into(),
    )
    .unwrap();

    assert_eq!(clip.title.chars().count(), 200);
    assert!(clip.title.starts_with("Bild Bild"));
    assert_eq!(clip.site, "example.com");
    assert_eq!(clip.markdown, format!("![]({IMAGE_PLACEHOLDER}0)"));
    assert_eq!(clip.byline, "");
    assert_eq!(clip.published, "");
}
