use crate::{
    Clip, Error, Extract,
    markdown::{self, IMAGE_PLACEHOLDER, SKIPPED, clean, collapse, tag},
};

use dom_query::{Document, NodeId, NodeRef};
use html5ever::{ParseOpts, tree_builder::TreeBuilderOpts};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

use tendril::{StrTendril, TendrilSink};
use url::Url;

const PARSE_CHUNK: usize = 1024;
const PARSE_BUDGET: Duration = Duration::from_secs(3);
const MAX_NODES: usize = 200_000;
const MAX_TREE_DEPTH: usize = 512;

const MAX_TITLE: usize = 200;
const MAX_META: usize = 200;
const MIN_PARAGRAPH: usize = 25;
const MIN_ARTICLE_SHARE_PERCENT: usize = 10;
const SCORED: &str = "p, pre, td";
const HIDDEN: &str = "[hidden], [role=navigation], [role=complementary], [role=dialog]";
const DECORATIVE: &str = "[aria-hidden=true] :is(p, pre, td), :is(p, pre, td)[aria-hidden=true]";
const BOILERPLATE: &[&str] = &[
    "comment",
    "share",
    "social",
    "related",
    "newsletter",
    "cookie",
    "consent",
    "advert",
    "promo",
    "subscribe",
    "sidebar",
    "popup",
    "modal",
    "breadcrumb",
    "signup",
    "paywall",
];
const CONTENT_HINTS: &[&str] = &["article", "content", "main", "body", "post", "entry"];

fn chunk_end(html: &str, start: usize) -> usize {
    let mut end = (start + PARSE_CHUNK).min(html.len());

    while !html.is_char_boundary(end) {
        end -= 1;
    }

    end
}

fn parsed(html: &str) -> Result<Document, Error> {
    let options = ParseOpts {
        tree_builder: TreeBuilderOpts {
            scripting_enabled: false,
            ..Default::default()
        },
        ..Default::default()
    };

    let started = Instant::now();
    let mut parser = html5ever::parse_document(Document::default(), options);
    let mut start = 0;

    while start < html.len() {
        if started.elapsed() > PARSE_BUDGET {
            return Err(Error::Complex);
        }

        let end = chunk_end(html, start);

        parser.process(StrTendril::from_slice(&html[start..end]));
        start = end;
    }

    let doc = parser.finish();

    check_shape(&doc)?;

    Ok(doc)
}

fn check_shape(doc: &Document) -> Result<(), Error> {
    let mut pending = vec![(doc.root(), 0)];
    let mut nodes = 0;

    while let Some((node, depth)) = pending.pop() {
        nodes += 1;

        if nodes > MAX_NODES || depth > MAX_TREE_DEPTH {
            return Err(Error::Complex);
        }

        pending.extend(node.children_it(false).map(|child| (child, depth + 1)));
    }

    Ok(())
}

pub fn read(html: &str, url: &Url, extract: Extract) -> Result<Clip, Error> {
    let doc = parsed(html)?;
    let title = first_filled(&[
        meta(&doc, r#"meta[property="og:title"]"#),
        doc.select("title").text().to_string(),
        doc.select_single("h1").text().to_string(),
    ]);
    let site = first_filled(&[meta(&doc, r#"meta[property="og:site_name"]"#), host(url)]);
    let byline = meta(&doc, r#"meta[name="author"]"#);
    let published = [
        meta(&doc, r#"meta[property="article:published_time"]"#),
        meta(&doc, r#"meta[name="date"]"#),
        doc.select_single("time[datetime]")
            .attr("datetime")
            .unwrap_or_default()
            .to_string(),
    ]
    .iter()
    .find_map(|value| date(value))
    .unwrap_or_default();

    doc.select(&SKIPPED.join(", ")).remove();
    doc.select(HIDDEN).remove();
    let root = match extract {
        Extract::Article => content_root(&doc),
        Extract::Whole => doc.body().unwrap_or_else(|| doc.root()),
    };

    if matches!(extract, Extract::Article) {
        remove_boilerplate(&root);
    }

    let converted = markdown::convert(&root, url);

    Ok(Clip {
        url: url.to_string(),
        title: line(&title, MAX_TITLE),
        site: line(&site, MAX_META),
        byline: line(&byline, MAX_META),
        published,
        markdown: converted.text,
        images: converted.images,
    })
}

pub fn picture(url: &Url, title: &str, image: String) -> Clip {
    Clip {
        url: url.to_string(),
        title: line(title, MAX_TITLE),
        site: line(&host(url), MAX_META),
        byline: String::new(),
        published: String::new(),
        markdown: format!("![]({IMAGE_PLACEHOLDER}0)"),
        images: vec![image],
    }
}

fn host(url: &Url) -> String {
    url.host_str()
        .unwrap_or_default()
        .trim_start_matches("www.")
        .to_string()
}

fn meta(doc: &Document, selector: &str) -> String {
    doc.select_single(selector)
        .attr("content")
        .unwrap_or_default()
        .to_string()
}

fn first_filled(values: &[String]) -> String {
    values
        .iter()
        .find(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_default()
}

fn line(text: &str, limit: usize) -> String {
    collapse(&clean(text)).chars().take(limit).collect()
}

fn date(value: &str) -> Option<String> {
    let prefix = value.trim().get(..10)?;
    let shape = prefix.char_indices().all(|(i, c)| {
        if i == 4 || i == 7 {
            c == '-'
        } else {
            c.is_ascii_digit()
        }
    });

    shape.then(|| prefix.to_string())
}

fn paragraph_length(text: &str) -> usize {
    text.split_whitespace()
        .map(|word| word.chars().count() + 1)
        .sum()
}

fn innermost_paragraphs(doc: &Document) -> Vec<NodeRef<'_>> {
    let scored = doc.select(SCORED).nodes().to_vec();
    let containers: HashSet<NodeId> = scored
        .iter()
        .flat_map(|node| node.ancestors_it(None).map(|ancestor| ancestor.id))
        .collect();

    scored
        .into_iter()
        .filter(|node| !containers.contains(&node.id))
        .collect()
}

fn content_root(doc: &Document) -> NodeRef<'_> {
    let fallback = doc.body().unwrap_or_else(|| doc.root());
    let decorative: HashSet<NodeId> = doc
        .select(DECORATIVE)
        .nodes()
        .iter()
        .map(|node| node.id)
        .collect();
    let (content, decoration): (Vec<_>, Vec<_>) = innermost_paragraphs(doc)
        .into_iter()
        .partition(|paragraph| !decorative.contains(&paragraph.id));

    let Some(best) = best_scored(content).or_else(|| best_scored(decoration)) else {
        return fallback;
    };

    let article = std::iter::once(best)
        .chain(best.ancestors_it(None))
        .find(|node| tag(node) == "article")
        .unwrap_or(best);

    if holds_enough_text(&article, &fallback) {
        article
    } else {
        fallback
    }
}

fn holds_enough_text(part: &NodeRef, page: &NodeRef) -> bool {
    paragraph_length(&part.text()) * 100
        >= paragraph_length(&page.text()) * MIN_ARTICLE_SHARE_PERCENT
}

fn best_scored(paragraphs: Vec<NodeRef<'_>>) -> Option<NodeRef<'_>> {
    let mut scores: HashMap<NodeId, (NodeRef, f64)> = HashMap::new();

    for paragraph in paragraphs {
        let text = paragraph.text();
        let length = paragraph_length(&text);

        if length < MIN_PARAGRAPH {
            continue;
        }

        let score = 1.0 + text.matches(',').count() as f64 + (length / 100).min(3) as f64;
        let Some(parent) = paragraph.parent() else {
            continue;
        };

        scores.entry(parent.id).or_insert((parent, 0.0)).1 += score;

        if let Some(grandparent) = parent.parent() {
            scores.entry(grandparent.id).or_insert((grandparent, 0.0)).1 += score / 2.0;
        }
    }

    scores
        .into_values()
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(node, _)| node)
}

fn remove_boilerplate(root: &NodeRef) {
    let doomed: Vec<NodeRef> = root
        .descendants_it()
        .filter(|node| node.is_element() && boilerplate(node))
        .collect();
    for node in doomed {
        node.remove_from_parent();
    }
}

fn boilerplate(node: &NodeRef) -> bool {
    let names = format!(
        "{} {}",
        node.class().unwrap_or_default(),
        node.id_attr().unwrap_or_default()
    )
    .to_ascii_lowercase();

    BOILERPLATE.iter().any(|word| names.contains(word))
        && !CONTENT_HINTS.iter().any(|word| names.contains(word))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<!doctype html><html><head>
        <title>Fallback</title>
        <meta property="og:title" content="Der  Artikel">
        <meta property="og:site_name" content="Beispiel">
        <meta name="author" content="Ada">
        <meta property="article:published_time" content="2026-11-02T08:00:00Z">
        </head><body>
        <nav><a href="/">Start</a></nav>
        <div class="sidebar"><p>Werbung, die niemand lesen will, aber sehr lang ist.</p></div>
        <article><h1>Der Artikel</h1>
          <p>Erster Absatz mit genug Text, damit er zählt, und mit Kommas, viele.</p>
          <div class="share-buttons"><p>Teilen auf allen Kanälen, sofort und überall jetzt.</p></div>
          <p>Zweiter Absatz, ebenfalls lang genug für die Bewertung des Inhalts.</p>
        </article>
        <footer><p>Impressum und rechtliche Hinweise, sehr lang und unwichtig.</p></footer>
        <script>steal()</script></body></html>"#;

    #[test]
    fn extracts_article_and_metadata() {
        let clip = read(
            PAGE,
            &Url::parse("https://www.example.com/a").unwrap(),
            Extract::Article,
        )
        .unwrap();

        assert_eq!(clip.title, "Der Artikel");
        assert_eq!(clip.site, "Beispiel");
        assert_eq!(clip.byline, "Ada");
        assert_eq!(clip.published, "2026-11-02");
        assert!(clip.markdown.starts_with("# Der Artikel\n\nErster Absatz"));
        assert!(clip.markdown.contains("Zweiter Absatz"));

        for junk in ["Werbung", "Teilen", "Impressum", "Start", "steal"] {
            assert!(!clip.markdown.contains(junk), "{junk}");
        }
    }

    #[test]
    fn falls_back_to_body_and_host() {
        let clip = read(
            "<p>kurz</p>",
            &Url::parse("https://www.example.com/").unwrap(),
            Extract::Article,
        )
        .unwrap();

        assert_eq!(clip.site, "example.com");
        assert_eq!(clip.markdown, "kurz");
        assert_eq!(clip.published, "");
    }

    #[test]
    fn whole_extraction_keeps_everything_visible() {
        let clip = read(
            PAGE,
            &Url::parse("https://www.example.com/a").unwrap(),
            Extract::Whole,
        )
        .unwrap();

        assert!(clip.markdown.contains("Werbung"));
        assert!(clip.markdown.contains("Teilen"));

        for junk in ["Impressum", "Start", "steal"] {
            assert!(!clip.markdown.contains(junk), "{junk}");
        }
    }

    #[test]
    fn picture_points_at_its_only_image() {
        let url = Url::parse("http://www.example.com/a").unwrap();
        let clip = picture(&url, "  Ein\nBild ", "https://cdn.example.com/b.png".into());

        assert_eq!(clip.title, "Ein Bild");
        assert_eq!(clip.site, "example.com");
        assert_eq!(clip.markdown, "![](clip-image:0)");
        assert_eq!(clip.images, ["https://cdn.example.com/b.png"]);
    }

    #[test]
    fn rejects_malformed_dates() {
        assert_eq!(date("2026-11-02"), Some("2026-11-02".into()));
        assert_eq!(date("02.11.2026"), None);
        assert_eq!(date("2026-1"), None);
        assert_eq!(date("2026-11-0ä"), None);
    }

    #[test]
    fn deeply_nested_pages_are_refused_instead_of_parsed() {
        let url = Url::parse("https://example.com/").unwrap();
        let deep = "<div>".repeat(MAX_TREE_DEPTH + 10);

        assert!(matches!(
            read(&deep, &url, Extract::Article),
            Err(Error::Complex)
        ));
    }

    #[test]
    fn a_page_that_would_parse_for_minutes_stops_at_the_budget() {
        let url = Url::parse("https://example.com/").unwrap();
        let started = Instant::now();
        let deep = "<div>".repeat(400_000);

        assert!(matches!(
            read(&deep, &url, Extract::Whole),
            Err(Error::Complex)
        ));
        assert!(started.elapsed() < PARSE_BUDGET * 3);
    }

    #[test]
    fn nested_tables_are_read_as_layout_without_copying_their_text() {
        let url = Url::parse("https://example.com/").unwrap();
        let levels = 100;
        let html = format!(
            "<article><p>Einleitung, lang genug für die Bewertung des Inhalts.</p>{}<p>{}</p>{}</article>",
            "<table><tr><td>".repeat(levels),
            "Satz, mit Komma und genug Text. ".repeat(60_000),
            "</td></tr></table>".repeat(levels)
        );
        let started = Instant::now();
        let clip = read(&html, &url, Extract::Whole).unwrap();

        assert!(clip.markdown.contains("Einleitung"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
