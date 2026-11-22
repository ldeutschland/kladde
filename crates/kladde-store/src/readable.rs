use std::collections::HashMap;

const HIDDEN_SCHEMES: [&str; 2] = ["kladde:", "kladde-file:"];
const ELLIPSIS: &str = "…";
const NAMED_ENTITIES: [(&str, char); 5] = [
    ("amp", '&'),
    ("lt", '<'),
    ("gt", '>'),
    ("quot", '"'),
    ("nbsp", ' '),
];
const LONGEST_ENTITY: usize = 10;

pub(crate) fn readable(markdown: &str) -> String {
    let mut fenced = false;
    let mut lines = Vec::new();

    for line in markdown.lines() {
        let trimmed = line.trim_start();

        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }

        let text = if fenced {
            line.to_owned()
        } else {
            inline_text(&without_link_targets(without_block_marks(line)))
        };

        if !text.trim().is_empty() {
            lines.push(text.trim().to_owned());
        }
    }

    lines.join("\n")
}

pub(crate) fn tidy(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn excerpt(window: &str, lead: usize, cut_before: bool, cut_after: bool) -> String {
    let chars: Vec<char> = window.chars().collect();
    let lead = lead.min(chars.len());
    let start = if cut_before {
        chars[..lead]
            .iter()
            .position(|c| c.is_whitespace())
            .map_or(lead, |space| space + 1)
    } else {
        0
    };

    let end = if cut_after {
        chars[lead..]
            .iter()
            .rposition(|c| c.is_whitespace())
            .map_or(chars.len(), |space| lead + space)
    } else {
        chars.len()
    };

    let body = tidy(&chars[start..end].iter().collect::<String>());
    let before = if cut_before {
        ELLIPSIS.to_owned() + " "
    } else {
        String::new()
    };

    let after = if cut_after {
        " ".to_owned() + ELLIPSIS
    } else {
        String::new()
    };

    before + &body + &after
}

fn without_block_marks(line: &str) -> &str {
    let mut rest = line.trim_start();

    loop {
        let next = strip_block_mark(rest).trim_start();

        if next.len() == rest.len() {
            return if is_rule(rest) { "" } else { rest };
        }

        rest = next;
    }
}

fn strip_block_mark(line: &str) -> &str {
    let hashes = line.len() - line.trim_start_matches('#').len();

    if (1..=6).contains(&hashes) && line[hashes..].starts_with(' ') {
        return &line[hashes..];
    }

    for mark in ["> ", "- ", "* ", "+ ", "[ ] ", "[x] ", "[X] "] {
        if let Some(rest) = line.strip_prefix(mark) {
            return rest;
        }
    }

    if line == ">" {
        return "";
    }

    let digits = line.len() - line.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let after = &line[digits..];

    if digits > 0 && (after.starts_with(". ") || after.starts_with(") ")) {
        return &after[1..];
    }

    line
}

fn is_rule(line: &str) -> bool {
    let marks: String = line.chars().filter(|c| !c.is_whitespace()).collect();

    marks.len() >= 3
        && (marks.chars().all(|c| c == '-')
            || marks.chars().all(|c| c == '*')
            || marks.chars().all(|c| c == '_')
            || marks.chars().all(|c| matches!(c, '|' | '-' | ':')))
}

fn inline_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(c) = rest.chars().next() {
        let width = c.len_utf8();
        let after = &rest[width..];

        rest = match c {
            '\\' => match after.chars().next() {
                Some(next) if next.is_ascii_punctuation() => {
                    out.push(next);
                    &after[1..]
                }
                _ => {
                    out.push(c);

                    after
                }
            },
            '<' => tag(after, &mut out).unwrap_or_else(|| {
                out.push(c);

                after
            }),
            '&' => entity(after, &mut out).unwrap_or_else(|| {
                out.push(c);

                after
            }),
            '*' | '`' => after,
            '~' if after.starts_with('~') => &after[1..],
            '|' => {
                out.push(' ');

                after
            }
            _ => {
                out.push(c);

                after
            }
        };
    }

    out
}

fn without_link_targets(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let escaped = escapes(&chars);
    let targets = pairs(&chars, &escaped, '(', ')');
    let mut dropped = vec![false; chars.len()];

    for (open, close) in pairs(&chars, &escaped, '[', ']') {
        let Some(&end) = targets.get(&(close + 1)) else {
            continue;
        };

        dropped[open] = true;
        dropped[close..=end].fill(true);

        if open > 0 && chars[open - 1] == '!' && !escaped[open - 1] {
            dropped[open - 1] = true;
        }
    }

    chars
        .into_iter()
        .zip(dropped)
        .filter_map(|(c, drop)| (!drop).then_some(c))
        .collect()
}

fn escapes(chars: &[char]) -> Vec<bool> {
    let mut escaped = vec![false; chars.len()];

    for index in 1..chars.len() {
        escaped[index] = chars[index - 1] == '\\' && !escaped[index - 1];
    }

    escaped
}

fn pairs(chars: &[char], escaped: &[bool], open: char, close: char) -> HashMap<usize, usize> {
    let mut waiting = Vec::new();
    let mut found = HashMap::new();

    for (index, &c) in chars.iter().enumerate() {
        if escaped[index] {
            continue;
        }

        if c == open {
            waiting.push(index);
        } else if c == close
            && let Some(start) = waiting.pop()
        {
            found.insert(start, index);
        }
    }

    found
}

fn tag<'a>(text: &'a str, out: &mut String) -> Option<&'a str> {
    let end = text.find(['>', '<', '\n'])?;

    if !text[end..].starts_with('>') {
        return None;
    }

    let inner = &text[..end];
    let first = inner.trim_start_matches('/').chars().next()?;

    if !first.is_ascii_alphabetic() {
        return None;
    }

    if is_autolink(inner) {
        if !HIDDEN_SCHEMES
            .iter()
            .any(|scheme| inner.starts_with(scheme))
        {
            out.push_str(inner);
        }
    } else {
        out.push(' ');
    }

    Some(&text[end + 1..])
}

fn is_autolink(inner: &str) -> bool {
    if inner.chars().any(char::is_whitespace) {
        return false;
    }

    let scheme = inner.split(':').next().unwrap_or_default();

    inner.contains('@')
        || (scheme.len() < inner.len()
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')))
}

fn entity<'a>(text: &'a str, out: &mut String) -> Option<&'a str> {
    let end = text[..text.floor_char_boundary(LONGEST_ENTITY)].find(';')?;
    let name = &text[..end];
    let decoded = match name.strip_prefix('#') {
        Some(number) => match number.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok(),
            None => number.parse().ok(),
        }
        .and_then(char::from_u32)
        .filter(|c| !c.is_control() || c.is_whitespace()),
        None => NAMED_ENTITIES
            .iter()
            .find(|(known, _)| *known == name)
            .map(|(_, c)| *c),
    }?;

    out.push(decoded);

    Some(&text[end + 1..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_blocks_leave_only_their_names() {
        let body = "Wartungsvertrag läuft bis Ende 2027.\n\n<audio src=\"kladde-file:f1ecb4dd-0000-4000-8000-000000000000\" />\n\n![Rechnung.png](kladde-file:a1ecb4dd-0000-4000-8000-000000000000)\n\n[Vertrag.pdf](kladde-file:b1ecb4dd-0000-4000-8000-000000000000)\n\n<video src=\"kladde-file:c1ecb4dd-0000-4000-8000-000000000000\"></video>";

        assert_eq!(
            readable(body),
            "Wartungsvertrag läuft bis Ende 2027.\nRechnung.png\nVertrag.pdf"
        );
    }

    #[test]
    fn markdown_marks_disappear() {
        let body = "# Titel\n\n> **fett** und *kursiv* mit `code` und ~~alt~~\n\n- [ ] offen\n- [x] erledigt\n1. erster\n\n---\n\n| A | B |\n| --- | :-: |\n| 1 | 2 |";

        assert_eq!(
            readable(body),
            "Titel\nfett und kursiv mit code und alt\noffen\nerledigt\nerster\nA   B\n1   2"
        );
    }

    #[test]
    fn links_keep_their_label_and_hide_internal_addresses() {
        let body = "Siehe [Projekt](kladde:2f1ecb4d-0000-4000-8000-000000000000), <https://example.org/a_b> und <kladde-file:x>.";

        assert_eq!(
            readable(body),
            "Siehe Projekt, https://example.org/a_b und ."
        );
    }

    #[test]
    fn escapes_entities_and_plain_brackets_stay_text() {
        let body = "5 \\* 3 &amp; a\\_b [kein Link] a < b > c 2 &lt; 3 &#x20;&#0;";

        assert_eq!(
            readable(body),
            "5 * 3 & a_b [kein Link] a < b > c 2 < 3  &#0;"
        );
    }

    #[test]
    fn nested_and_escaped_links() {
        let body = "[![Foto.png](kladde-file:a)](https://x.y/(a)) \\[nein](b) \\\\[ja](c) ![](d)";

        assert_eq!(readable(body), "Foto.png [nein](b) \\ja");
    }

    #[test]
    fn hostile_lines_stay_linear() {
        let open = "[".repeat(1_000_000) + "](x)";
        let nested = "[".repeat(100_000) + "a" + &"](b)".repeat(100_000);
        let started = std::time::Instant::now();

        assert_eq!(readable(&open), "[".repeat(999_999));
        assert_eq!(readable(&nested), "a");
        assert!(started.elapsed().as_secs() < 5);
    }

    #[test]
    fn code_fences_keep_their_lines() {
        assert_eq!(
            readable("```rust\nlet a = *b;\n```\nnach"),
            "let a = *b;\nnach"
        );
    }

    #[test]
    fn excerpt_cuts_at_word_edges_and_marks_cuts() {
        assert_eq!(
            excerpt("rtrag läuft\n\u{c}bis Ende", 6, true, true),
            "… läuft bis …"
        );
        assert_eq!(excerpt("Vertrag läuft", 0, false, false), "Vertrag läuft");
        assert_eq!(excerpt("einwort", 3, true, true), "… wort …");
    }
}
