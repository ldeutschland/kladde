use kladde_clip::{Clip, Error, Extract, IMAGE_PLACEHOLDER, read_html};

const PAGE: &str = "https://news.example.com/artikel";
const MAX_IMAGES: usize = 20;
const MAX_MARKDOWN: usize = 300_000;
const MAX_TITLE: usize = 200;

fn whole(html: &str) -> Clip {
    read_html(html, PAGE, Extract::Whole).unwrap()
}

fn page(body: &str) -> String {
    format!("<!doctype html><html><head><title>T</title></head><body>{body}</body></html>")
}

#[test]
fn scripts_styles_and_event_handlers_never_reach_the_markdown() {
    let clip = whole(&page(
        "<p onclick=\"steal()\" onmouseover=\"steal()\">Sichtbar</p>\
         <style>p{background:url(https://evil.example/x)}</style>\
         <script>steal()</script><noscript>ohne Skript</noscript>\
         <template><p>Vorlage</p></template>\
         <iframe srcdoc=\"<p>eingebettet</p>\"></iframe>\
         <svg><script>steal()</script><text>Grafik</text></svg>\
         <math><mi>x</mi></math><object data=\"x.swf\">Objekt</object>\
         <form action=\"https://evil.example\"><input value=\"Formular\"><button>Senden</button></form>\
         <!-- versteckter Kommentar -->",
    ));

    assert_eq!(clip.markdown, "Sichtbar");
}

#[test]
fn hidden_and_dialog_content_is_dropped() {
    let clip = whole(&page(
        "<p>Offen</p><div hidden>Versteckt</div>\
         <div role=\"dialog\">Dialog</div><div role=\"navigation\">Menü</div>\
         <dialog open>Fenster</dialog><aside>Randnotiz</aside>",
    ));

    assert_eq!(clip.markdown, "Offen");
}

#[test]
fn aria_hidden_text_is_kept_because_it_is_still_visible() {
    let clip = whole(&page(
        "<a href=\"/neu\" aria-label=\"Neuigkeit\"><div aria-hidden=\"true\">Kartentext</div></a>",
    ));

    assert_eq!(
        clip.markdown,
        "[Kartentext](<https://news.example.com/neu>)"
    );
}

#[test]
fn article_choice_skips_aria_hidden_duplicates() {
    let slide = "<p>Spendenaufruf, Spendenaufruf, Spendenaufruf, immer wieder derselbe Text.</p>";
    let html = page(&format!(
        "<div aria-hidden=\"true\"><div>{}</div></div>\
         <div><p>Der eigentliche Artikel beginnt hier, mit genug Text.</p>\
         <p>Und er geht weiter, ebenfalls lang genug für die Bewertung.</p></div>",
        slide.repeat(6)
    ));
    let clip = read_html(&html, PAGE, Extract::Article).unwrap();

    assert!(clip.markdown.starts_with("Der eigentliche Artikel"));
    assert!(!clip.markdown.contains("Spendenaufruf"));
}

#[test]
fn article_choice_falls_back_to_aria_hidden_content_behind_a_modal() {
    let html = page(
        "<div id=\"app\" aria-hidden=\"true\"><main><div>\
         <p>Der Artikel liegt hinter einem offenen Dialog, bleibt aber lesbar.</p>\
         <p>Auch der zweite Absatz muss im Clip ankommen, nicht nur Bilder.</p>\
         </div></main></div><div role=\"dialog\"><p>Cookies erlauben?</p></div>",
    );
    let clip = read_html(&html, PAGE, Extract::Article).unwrap();

    assert!(clip.markdown.contains("Der Artikel liegt"));
    assert!(clip.markdown.contains("zweite Absatz"));
    assert!(!clip.markdown.contains("Cookies"));
}

#[test]
fn a_tiny_article_choice_falls_back_to_the_whole_page() {
    let description =
        "<span>Eine App-Beschreibung, die in Divs statt Absätzen steht.</span> ".repeat(30);
    let html = page(&format!(
        "<h1>Hex</h1><div>{description}</div>\
         <div><p>Das Entwicklungsteam hat Angaben zum Datenschutz gemacht.</p></div>"
    ));
    let clip = read_html(&html, PAGE, Extract::Article).unwrap();

    assert!(clip.markdown.starts_with("# Hex"));
    assert!(clip.markdown.contains("in Divs statt"));
}

#[test]
fn obfuscated_script_links_keep_only_their_text() {
    let clip = whole(&page(
        "<p><a href=\"  JaVaScRiPt:alert(1)\">eins</a> \
         <a href=\"java&#x09;script:alert(1)\">zwei</a> \
         <a href=\"java\nscript:alert(1)\">drei</a> \
         <a href=\"vbscript:msgbox(1)\">vier</a> \
         <a href=\"data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;\">fünf</a> \
         <a href=\"file:///etc/passwd\">sechs</a> \
         <a href=\"https://user:pw@evil.example/\">sieben</a></p>",
    ));

    assert_eq!(clip.markdown, "eins zwei drei vier fünf sechs sieben");
}

#[test]
fn link_targets_cannot_break_out_of_their_markdown_destination() {
    let clip = whole(&page(
        "<p><a href=\"/x>)[böse](javascript:alert(1)\">Text</a> \
         <a href=\"https://example.org/a b<c>\">Zwei</a></p>",
    ));

    assert_eq!(clip.markdown.matches('<').count(), 2, "{}", clip.markdown);
    assert_eq!(clip.markdown.matches('>').count(), 2, "{}", clip.markdown);
    assert!(
        clip.markdown
            .starts_with("[Text](<https://news.example.com/x%3E)[b%C3%B6se](javascript:alert(1)>)"),
        "{}",
        clip.markdown
    );
    assert!(
        clip.markdown
            .contains("[Zwei](<https://example.org/a%20b%3Cc%3E>)"),
        "{}",
        clip.markdown
    );
}

#[test]
fn a_base_element_cannot_redirect_relative_links() {
    let clip = whole(
        "<html><head><base href=\"https://evil.example/\"></head>\
         <body><p><a href=\"/weiter\">weiter</a></p></body></html>",
    );

    assert_eq!(clip.markdown, "[weiter](<https://news.example.com/weiter>)");
}

#[test]
fn unsafe_image_sources_are_not_collected() {
    let clip = whole(&page(
        "<p>Bilder</p>\
         <img src=\"javascript:alert(1)\">\
         <img src=\"http://169.254.169.254/latest/meta-data\">\
         <img src=\"//10.0.0.1/a.png\">\
         <img src=\"https://user@cdn.example.com/a.png\">\
         <img src=\"https://cdn.example.com:8443/a.png\">\
         <img src=\"https://printer.local/a.png\">\
         <img src=\" DATA:image/png;base64,AAAA\">\
         <img src=\"https://cdn.example.com/spy.gif\" height=\" 0 \">",
    ));

    assert!(clip.images.is_empty(), "{:?}", clip.images);
    assert_eq!(clip.markdown, "Bilder");
}

#[test]
fn images_on_a_private_page_are_not_resolved_against_it() {
    let clip = read_html(
        "<p>Interne Seite</p><img src=\"/logo.png\">",
        "http://192.168.1.10/wiki",
        Extract::Whole,
    )
    .unwrap();

    assert!(clip.images.is_empty());
}

#[test]
fn images_are_upgraded_deduplicated_and_capped() {
    let mut body = String::from(
        "<p>Galerie</p><img src=\"http://cdn.example.com/0.png\">\
         <img src=\"https://cdn.example.com/0.png\">\
         <img srcset=\"https://cdn.example.com/s.png 1x, https://cdn.example.com/l.png 2x\">",
    );

    for index in 1..40 {
        body.push_str(&format!("<img src=\"/bild{index}.png\">"));
    }

    let clip = whole(&page(&body));

    assert_eq!(clip.images.len(), MAX_IMAGES);
    assert_eq!(clip.images[0], "https://cdn.example.com/0.png");
    assert_eq!(clip.images[1], "https://cdn.example.com/s.png");
    assert!(clip.markdown.contains(&format!("({IMAGE_PLACEHOLDER}19)")));
    assert!(!clip.markdown.contains(&format!("({IMAGE_PLACEHOLDER}20)")));
}

#[test]
fn image_alt_text_cannot_inject_markdown() {
    let clip = whole(&page(
        "<p>Bild</p><img src=\"/a.png\" alt=\"](javascript:alert(1)) ![x\" onerror=\"steal()\">",
    ));

    assert_eq!(
        clip.markdown,
        format!("Bild\n\n![\\]\\(javascript\\:alert\\(1\\)\\) \\!\\[x]({IMAGE_PLACEHOLDER}0)")
    );
}

#[test]
fn page_text_cannot_start_new_markdown_blocks() {
    let clip = whole(&page(
        "<p>Zeile\n# Überschrift\n- Punkt\n> Zitat\n```code</p>",
    ));

    assert_eq!(
        clip.markdown,
        "Zeile \\# Überschrift \\- Punkt \\> Zitat \\`\\`\\`code"
    );
}

#[test]
fn metadata_is_cleaned_collapsed_and_truncated() {
    let long_title = "Titel ".repeat(100);
    let html = format!(
        "<html><head><meta property=\"og:title\" content=\"{long_title}\">\
         <meta property=\"og:site_name\" content=\"Seite\u{202e}\u{200b}\n\tName\">\
         <meta name=\"author\" content=\"Ada\u{0007} Lovelace\">\
         <meta name=\"date\" content=\"&lt;script&gt;\">\
         </head><body><p>Inhalt</p></body></html>"
    );
    let clip = whole(&html);

    assert_eq!(clip.title.chars().count(), MAX_TITLE);
    assert!(clip.title.starts_with("Titel Titel"));
    assert_eq!(clip.site, "Seite Name");
    assert_eq!(clip.byline, "Ada Lovelace");
    assert_eq!(clip.published, "");
}

#[test]
fn hostile_source_addresses_are_refused_before_parsing() {
    for address in [
        "javascript:alert(1)",
        "https://user:pw@example.com/",
        "data:text/html,<p>x</p>",
        "",
    ] {
        assert!(
            matches!(
                read_html("<p>Text</p>", address, Extract::Whole),
                Err(Error::Address)
            ),
            "{address}"
        );
    }
}

#[test]
fn pages_with_too_many_nodes_are_refused() {
    let html = "<b></b>".repeat(200_001);

    assert!(matches!(
        read_html(&html, PAGE, Extract::Whole),
        Err(Error::Complex)
    ));
}

#[test]
fn deep_block_nesting_is_flattened_instead_of_overflowing() {
    let depth = 400;
    let html = format!(
        "{}<p>Kern *Text*</p>{}",
        "<div>".repeat(depth),
        "</div>".repeat(depth)
    );

    assert_eq!(whole(&html).markdown, "Kern \\*Text\\*");
}

#[test]
fn markdown_output_is_bounded() {
    let paragraph = format!("<p>{}</p>", "Wort ".repeat(40));
    let clip = whole(&paragraph.repeat(3_000));

    assert!(
        clip.markdown.len() <= MAX_MARKDOWN,
        "{}",
        clip.markdown.len()
    );
    assert!(clip.markdown.len() > MAX_MARKDOWN / 2);
}

#[test]
fn article_extraction_still_strips_hostile_markup() {
    let text = "Ein langer Absatz, mit Kommas, damit er als Inhalt zählt, und weiter.";
    let html = format!(
        "<div class=\"newsletter-popup\"><p>{text} Werbung</p></div>\
         <article><p onclick=\"x()\">{text}</p><script>steal()</script>\
         <p><a href=\"javascript:alert(1)\">Link</a> {text}</p></article>"
    );
    let clip = read_html(&html, PAGE, Extract::Article).unwrap();

    assert!(!clip.markdown.contains("Werbung"));
    assert!(!clip.markdown.contains("steal"));
    assert!(!clip.markdown.contains("javascript"));
    assert!(clip.markdown.starts_with("Ein langer Absatz"));
}
