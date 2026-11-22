use crate::address;
use dom_query::NodeRef;
use url::Url;

const MAX_DEPTH: usize = 40;
const MAX_IMAGES: usize = 20;
const MAX_MARKDOWN: usize = 300_000;
const MAX_CODE: usize = 50_000;
const MAX_ALT: usize = 200;
const MAX_TABLE_ROWS: usize = 500;
const MAX_TABLE_COLUMNS: usize = 30;
const MAX_HEADING_LEVEL: usize = 3;
const TRACKING_PIXEL_SIZES: &[&str] = &["0", "1", "2"];
pub const IMAGE_PLACEHOLDER: &str = "clip-image:";
pub const SKIPPED: &[&str] = &[
    "script", "style", "noscript", "template", "iframe", "frame", "frameset", "object", "embed",
    "svg", "math", "canvas", "form", "input", "button", "select", "textarea", "nav", "aside",
    "footer", "dialog", "head", "link", "meta", "title",
];
const BLOCKS: &[&str] = &[
    "address",
    "article",
    "blockquote",
    "body",
    "center",
    "dd",
    "details",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hgroup",
    "hr",
    "li",
    "main",
    "ol",
    "p",
    "pre",
    "section",
    "summary",
    "table",
    "ul",
];

pub struct Markdown {
    pub text: String,
    pub images: Vec<String>,
}

pub fn convert(root: &NodeRef, base: &Url) -> Markdown {
    let mut writer = Writer {
        base,
        blocks: Vec::new(),
        images: Vec::new(),
        pending: Vec::new(),
        size: 0,
    };

    writer.children(root, 0);

    Markdown {
        text: writer.blocks.join("\n\n"),
        images: writer.images,
    }
}

pub fn tag(node: &NodeRef) -> String {
    node.node_name()
        .map(|name| name.to_ascii_lowercase())
        .unwrap_or_default()
}

pub fn clean(text: &str) -> String {
    text.chars().filter(|c| !hidden(*c)).collect()
}

pub fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());

    for c in text.chars().filter(|c| !hidden(*c)) {
        if c.is_ascii_punctuation() {
            out.push('\\');
        }

        out.push(c);
    }

    out
}

fn hidden(c: char) -> bool {
    (c.is_control() && !c.is_whitespace())
        || matches!(c, '\u{200b}' | '\u{feff}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

fn is_block(node: &NodeRef) -> bool {
    node.is_element() && BLOCKS.contains(&tag(node).as_str())
}

fn surround(inner: String, open: &str, close: &str) -> String {
    let text = collapse(&inner);

    if text.is_empty() {
        return inner;
    }

    let lead = if inner.starts_with(char::is_whitespace) {
        " "
    } else {
        ""
    };

    let trail = if inner.ends_with(char::is_whitespace) {
        " "
    } else {
        ""
    };

    format!("{lead}{open}{text}{close}{trail}")
}

fn longest_backtick_run(text: &str) -> usize {
    text.split(|c| c != '`').map(str::len).max().unwrap_or(0)
}

fn code_span(text: &str) -> String {
    let text = collapse(&clean(text));

    if text.is_empty() {
        return String::new();
    }

    let fence = "`".repeat(longest_backtick_run(&text) + 1);

    format!("{fence} {text} {fence}")
}

fn code_block(text: &str) -> String {
    let code: String = clean(text).chars().take(MAX_CODE).collect();
    let code = code.trim_matches('\n').trim_end();

    if code.is_empty() {
        return String::new();
    }

    let fence = "`".repeat(longest_backtick_run(code).max(2) + 1);

    format!("{fence}\n{code}\n{fence}")
}

struct Writer<'a> {
    base: &'a Url,
    blocks: Vec<String>,
    images: Vec<String>,
    pending: Vec<String>,
    size: usize,
}

impl Writer<'_> {
    fn push(&mut self, block: String) {
        if block.trim().is_empty() || self.size + block.len() > MAX_MARKDOWN {
            return;
        }

        self.size += block.len() + 2;
        self.blocks.push(block);
    }

    fn finish(&mut self, block: String) {
        self.push(block);

        for image in std::mem::take(&mut self.pending) {
            self.push(image);
        }
    }

    fn children(&mut self, node: &NodeRef, depth: usize) {
        let mut inline = String::new();

        for child in node.children() {
            if is_block(&child) {
                self.finish(collapse(&std::mem::take(&mut inline)));
                self.block(&child, depth + 1);
            } else {
                inline.push_str(&self.inline(&child, depth + 1));
            }
        }

        self.finish(collapse(&inline));
    }

    fn block(&mut self, node: &NodeRef, depth: usize) {
        if depth > MAX_DEPTH {
            return self.push(collapse(&escape(&node.text())));
        }

        let name = tag(node);

        match name.as_str() {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => self.heading(node, &name, depth),
            "p" | "dt" | "dd" | "summary" | "li" => {
                let text = collapse(&self.inline_children(node, depth));

                self.finish(text);
            }
            "figcaption" => {
                let text = surround(self.inline_children(node, depth), "*", "*");

                self.finish(collapse(&text));
            }
            "blockquote" => {
                let text = collapse(&self.inline_children(node, depth));

                self.finish(if text.is_empty() {
                    text
                } else {
                    format!("> {text}")
                });
            }
            "ul" | "ol" => {
                let list = self.list(node, name == "ol", 0, depth);

                self.finish(list);
            }
            "pre" => self.push(code_block(&node.text())),
            "hr" => self.push("---".into()),
            "table" => self.table(node, depth),
            _ => self.children(node, depth),
        }
    }

    fn heading(&mut self, node: &NodeRef, name: &str, depth: usize) {
        let level = name[1..]
            .parse::<usize>()
            .unwrap_or(1)
            .min(MAX_HEADING_LEVEL);
        let text = collapse(&self.inline_children(node, depth));
        let block = if text.is_empty() {
            text
        } else {
            format!("{} {text}", "#".repeat(level))
        };

        self.finish(block);
    }

    fn inline_children(&mut self, node: &NodeRef, depth: usize) -> String {
        let mut out = String::new();

        for child in node.children() {
            out.push_str(&self.inline(&child, depth + 1));
        }

        out
    }

    fn inline(&mut self, node: &NodeRef, depth: usize) -> String {
        if node.is_text() {
            return escape(&node.text());
        }

        if !node.is_element() || depth > MAX_DEPTH {
            return String::new();
        }

        let name = tag(node);

        match name.as_str() {
            _ if SKIPPED.contains(&name.as_str()) => String::new(),
            "br" => " ".into(),
            "img" => {
                self.image(node);

                String::new()
            }
            "strong" | "b" => surround(self.inline_children(node, depth), "**", "**"),
            "em" | "i" => surround(self.inline_children(node, depth), "*", "*"),
            "s" | "del" | "strike" => surround(self.inline_children(node, depth), "~~", "~~"),
            "code" | "kbd" | "samp" => code_span(&node.text()),
            "a" => self.link(node, depth),
            _ if BLOCKS.contains(&name.as_str()) => {
                format!(" {} ", self.inline_children(node, depth))
            }
            _ => self.inline_children(node, depth),
        }
    }

    fn link(&mut self, node: &NodeRef, depth: usize) -> String {
        let inner = self.inline_children(node, depth);

        match node.attr("href").and_then(|href| self.link_target(&href)) {
            Some(target) => surround(inner, "[", &format!("](<{target}>)")),
            None => inner,
        }
    }

    fn link_target(&self, href: &str) -> Option<String> {
        let url = self.base.join(href.trim()).ok()?;
        let safe = matches!(url.scheme(), "https" | "http")
            && url.username().is_empty()
            && url.password().is_none()
            && url.as_str().len() <= address::MAX_ADDRESS
            && !url
                .as_str()
                .contains(|c: char| c.is_whitespace() || c.is_control() || c == '<' || c == '>');
        safe.then(|| url.to_string())
    }

    fn image(&mut self, node: &NodeRef) {
        if self.images.len() >= MAX_IMAGES {
            return;
        }

        let tiny = ["width", "height"].iter().any(|size| {
            node.attr(size)
                .is_some_and(|v| TRACKING_PIXEL_SIZES.contains(&v.trim()))
        });
        let Some(url) = self.image_source(node).filter(|_| !tiny) else {
            return;
        };

        if self.images.contains(&url) {
            return;
        }

        let alt: String = collapse(&escape(&node.attr("alt").unwrap_or_default()))
            .chars()
            .take(MAX_ALT)
            .collect();
        self.pending.push(format!(
            "![{alt}]({IMAGE_PLACEHOLDER}{})",
            self.images.len()
        ));
        self.images.push(url);
    }

    fn image_source(&self, node: &NodeRef) -> Option<String> {
        let srcset = node.attr("srcset").and_then(|set| {
            set.split(',')
                .next()
                .and_then(|c| c.split_whitespace().next())
                .map(str::to_string)
        });
        let candidates = [
            node.attr("src").map(|s| s.to_string()),
            node.attr("data-src").map(|s| s.to_string()),
            srcset,
        ];

        candidates
            .into_iter()
            .flatten()
            .filter(|src| !src.trim_start().to_ascii_lowercase().starts_with("data:"))
            .find_map(|src| {
                let mut url = self.base.join(src.trim()).ok()?;

                if url.scheme() == "http" {
                    url.set_scheme("https").ok()?;
                }

                address::check(&url).ok().map(|_| url.to_string())
            })
    }

    fn list(&mut self, node: &NodeRef, ordered: bool, indent: usize, depth: usize) -> String {
        let mut lines = Vec::new();
        let items = node
            .element_children()
            .into_iter()
            .filter(|item| tag(item) == "li");
        for (index, item) in items.enumerate() {
            let marker = if ordered {
                format!("{}. ", index + 1)
            } else {
                "- ".to_string()
            };

            let mut text = String::new();
            let mut nested = Vec::new();

            for child in item.children() {
                let name = tag(&child);

                if (name == "ul" || name == "ol") && depth < MAX_DEPTH {
                    nested.push(self.list(&child, name == "ol", indent + marker.len(), depth + 1));
                } else {
                    text.push_str(&self.inline(&child, depth + 1));
                }
            }

            lines.push(format!("{}{marker}{}", " ".repeat(indent), collapse(&text)));
            lines.extend(nested.into_iter().filter(|list| !list.is_empty()));
        }

        lines.join("\n")
    }

    fn table(&mut self, node: &NodeRef, depth: usize) {
        let layout = node
            .descendants_it()
            .any(|n| matches!(tag(&n).as_str(), "table" | "ul" | "ol" | "pre" | "img"));

        if layout {
            return self.children(node, depth);
        }

        let rows: Vec<Vec<String>> = node
            .descendants_it()
            .filter(|n| tag(n) == "tr")
            .take(MAX_TABLE_ROWS)
            .map(|row| {
                row.element_children()
                    .iter()
                    .filter(|cell| matches!(tag(cell).as_str(), "td" | "th"))
                    .take(MAX_TABLE_COLUMNS)
                    .map(|cell| collapse(&escape(&cell.text())))
                    .collect()
            })
            .collect();
        let columns = rows.iter().map(Vec::len).max().unwrap_or(0);

        if columns < 2 {
            return self.children(node, depth);
        }

        let mut lines = Vec::new();

        for (index, row) in rows.iter().enumerate() {
            let cells: Vec<&str> = (0..columns)
                .map(|c| row.get(c).map(String::as_str).unwrap_or(""))
                .collect();
            lines.push(format!("| {} |", cells.join(" | ")));

            if index == 0 {
                lines.push(format!("|{}", " --- |".repeat(columns)));
            }
        }

        self.push(lines.join("\n"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dom_query::Document;

    fn convert_html(html: &str) -> Markdown {
        let doc = Document::from(html);
        let base = Url::parse("https://example.com/articles/one").unwrap();

        convert(&doc.body().unwrap(), &base)
    }

    #[test]
    fn escapes_markup_from_page_text() {
        let md =
            convert_html("<p>&lt;img src=x onerror=alert(1)&gt; *not bold* [x](javascript:y)</p>");
        assert_eq!(
            md.text,
            "\\<img src\\=x onerror\\=alert\\(1\\)\\> \\*not bold\\* \\[x\\]\\(javascript\\:y\\)"
        );
    }

    #[test]
    fn drops_scripts_and_unsafe_links() {
        let md = convert_html(
            "<p>Hi<script>alert(1)</script> <a href=\"javascript:alert(1)\">bad</a> <a href=\"/b\">good</a></p><form><input value=x></form>",
        );

        assert_eq!(md.text, "Hi bad [good](<https://example.com/b>)");
    }

    #[test]
    fn keeps_structure() {
        let md = convert_html(
            "<h1>Title</h1><h4>Deep</h4><p>A <strong>bold</strong> <em>word</em>.</p><ul><li>one<ul><li>inner</li></ul></li><li>two</li></ul><ol><li>first</li></ol><blockquote><p>quote</p></blockquote><hr>",
        );

        assert_eq!(
            md.text,
            "# Title\n\n### Deep\n\nA **bold** *word*\\.\n\n- one\n  - inner\n- two\n\n1. first\n\n> quote\n\n---"
        );
    }

    #[test]
    fn fences_code_longer_than_its_content() {
        let md = convert_html("<pre>a ```\n<b>x</b></pre><p><code>x`y</code></p>");

        assert_eq!(md.text, "````\na ```\nx\n````\n\n`` x`y ``");
    }

    #[test]
    fn collects_images_as_placeholders() {
        let md = convert_html(
            "<p>Text <img src=\"/a.png\" alt=\"A [b]\"></p><img src=\"data:image/png;base64,AA\"><img src=\"https://127.0.0.1/x.png\"><img src=\"/pixel.gif\" width=\"1\"><img data-src=\"http://cdn.example.org/c.jpg\">",
        );

        assert_eq!(
            md.images,
            ["https://example.com/a.png", "https://cdn.example.org/c.jpg"]
        );
        assert_eq!(
            md.text,
            "Text\n\n![A \\[b\\]](clip-image:0)\n\n![](clip-image:1)"
        );
    }

    #[test]
    fn converts_data_tables() {
        let md = convert_html("<table><tr><th>a|b</th><th>c</th></tr><tr><td>1</td></tr></table>");

        assert_eq!(md.text, "| a\\|b | c |\n| --- | --- |\n| 1 |  |");
    }

    #[test]
    fn strips_invisible_direction_marks() {
        let md = convert_html("<p>pay\u{202e}lpt.exe</p>");

        assert_eq!(md.text, "paylpt\\.exe");
    }
}
