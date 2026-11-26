use quick_xml::{Reader, events::Event};
use serde::Serialize;
use std::io::{Cursor, Read};
use zeroize::Zeroizing;

pub const PREVIEW_EDGE: usize = 2400;
pub const THUMBNAIL_EDGE: usize = 256;
pub(super) const TEXT_LIMIT: usize = 1_048_576;
const XML_LIMIT: u64 = 16 * 1024 * 1024;
const MAX_FOUND_BOXES: usize = 64;
const MAX_FILE_BOXES: usize = 1000;

unsafe extern "C" {
    fn kladde_file_preview(
        bytes: *const u8,
        length: usize,
        index: usize,
        pdf: bool,
        edge: usize,
        result: *mut std::ffi::c_void,
        copy: unsafe extern "C" fn(*mut std::ffi::c_void, *const u8, usize),
    ) -> usize;

    fn kladde_find_boxes(
        bytes: *const u8,
        length: usize,
        index: usize,
        pdf: bool,
        term: *const std::ffi::c_char,
        boxes: *mut f32,
        capacity: usize,
    ) -> usize;

    fn kladde_find_all(
        bytes: *const u8,
        length: usize,
        pdf: bool,
        term: *const std::ffi::c_char,
        known: *const u8,
        known_length: usize,
        known_pages: usize,
        places: *mut u32,
        boxes: *mut f32,
        capacity: usize,
    ) -> usize;

    fn kladde_recognize(
        bytes: *const u8,
        length: usize,
        pdf: bool,
        buffer: *mut u8,
        capacity: usize,
        written: *mut usize,
    ) -> i32;
}

pub fn is_pdf(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(1024)]
        .windows(5)
        .any(|w| w == b"%PDF-")
}

pub fn preview(bytes: &[u8], index: usize, edge: usize) -> Option<(usize, String)> {
    unsafe extern "C" fn copy(result: *mut std::ffi::c_void, data: *const u8, len: usize) {
        use base64::{Engine, engine::general_purpose::STANDARD};

        if !data.is_null() && len > 0 {
            let jpeg = unsafe { std::slice::from_raw_parts(data, len) };

            STANDARD.encode_string(jpeg, unsafe { &mut *result.cast::<String>() });
        }
    }

    let mut jpeg = String::new();
    let pages = unsafe {
        kladde_file_preview(
            bytes.as_ptr(),
            bytes.len(),
            index,
            is_pdf(bytes),
            edge,
            (&raw mut jpeg).cast(),
            copy,
        )
    };

    if pages == 0 || jpeg.is_empty() {
        return None;
    }

    Some((pages, jpeg))
}

pub type FoundBox = [f32; 4];

pub fn found_boxes(bytes: &[u8], index: usize, term: &str) -> Vec<FoundBox> {
    let Ok(term) = std::ffi::CString::new(term) else {
        return Vec::new();
    };

    let mut boxes = [[0f32; 4]; MAX_FOUND_BOXES];
    let count = unsafe {
        kladde_find_boxes(
            bytes.as_ptr(),
            bytes.len(),
            index,
            is_pdf(bytes),
            term.as_ptr(),
            boxes.as_mut_ptr().cast(),
            MAX_FOUND_BOXES,
        )
    };

    boxes[..count.min(MAX_FOUND_BOXES)]
        .iter()
        .filter_map(|found| inside_page(*found))
        .collect()
}

#[derive(Serialize)]
pub struct FoundMatch {
    page: u32,
    boxes: Vec<FoundBox>,
}

pub struct IndexedText<'a> {
    pub text: &'a str,
    pub pages: usize,
}

pub fn found_matches(bytes: &[u8], term: &str, indexed: &IndexedText) -> Vec<FoundMatch> {
    let Ok(term) = std::ffi::CString::new(term) else {
        return Vec::new();
    };

    let mut places = vec![[0u32; 2]; MAX_FILE_BOXES];
    let mut boxes = vec![[0f32; 4]; MAX_FILE_BOXES];
    let count = unsafe {
        kladde_find_all(
            bytes.as_ptr(),
            bytes.len(),
            is_pdf(bytes),
            term.as_ptr(),
            indexed.text.as_ptr(),
            indexed.text.len(),
            indexed.pages,
            places.as_mut_ptr().cast(),
            boxes.as_mut_ptr().cast(),
            MAX_FILE_BOXES,
        )
    }
    .min(MAX_FILE_BOXES);

    grouped(&places[..count], &boxes[..count])
}

fn grouped(places: &[[u32; 2]], boxes: &[FoundBox]) -> Vec<FoundMatch> {
    let mut found: Vec<(u32, FoundMatch)> = Vec::new();

    for (&[page, number], &found_box) in places.iter().zip(boxes) {
        if found.last().is_none_or(|(last, _)| *last != number) {
            let boxes = Vec::new();

            found.push((number, FoundMatch { page, boxes }));
        }

        if let (Some(inside), Some((_, current))) = (inside_page(found_box), found.last_mut()) {
            current.boxes.push(inside);
        }
    }

    found.into_iter().map(|(_, found)| found).collect()
}

fn inside_page([x, y, width, height]: FoundBox) -> Option<FoundBox> {
    if ![x, y, width, height].iter().all(|v| v.is_finite()) {
        return None;
    }

    let (left, top) = (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0));
    let right = (x + width).clamp(0.0, 1.0);
    let bottom = (y + height).clamp(0.0, 1.0);

    (right > left && bottom > top).then_some([left, top, right - left, bottom - top])
}

pub struct Extraction {
    pub status: &'static str,
    pub text: Zeroizing<String>,
}

impl Extraction {
    pub(super) fn new(status: &'static str, text: String) -> Self {
        Self {
            status,
            text: Zeroizing::new(text.replace(['\0', '\u{1e}', '\u{1f}'], " ")),
        }
    }
}

pub fn extract(bytes: &[u8], name: &str) -> Extraction {
    if bytes.starts_with(b"PK\x03\x04") {
        return office(bytes).unwrap_or_else(|| Extraction::new("unreadable", String::new()));
    }

    let pdf = is_pdf(bytes);

    if !pdf
        && let Ok(text) = std::str::from_utf8(bytes)
        && text.chars().all(|c| !c.is_control() || c.is_whitespace())
    {
        let end = text.floor_char_boundary(TEXT_LIMIT.min(text.len()));
        let status = if end < text.len() { "partial" } else { "ready" };

        return Extraction::new(
            status,
            text[..end].trim_start_matches('\u{feff}').to_owned(),
        );
    }

    let mut buffer = Zeroizing::new(vec![0; TEXT_LIMIT]);
    let mut length = 0;
    let result = unsafe {
        kladde_recognize(
            bytes.as_ptr(),
            bytes.len(),
            pdf,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut length,
        )
    };

    let status = match result {
        0 => "ready",
        1 => "partial",
        -2 if !name.to_lowercase().ends_with(".pdf") => "unsupported",
        _ => "unreadable",
    };

    let Some(text) = buffer
        .get(..length)
        .and_then(|b| std::str::from_utf8(b).ok())
    else {
        return Extraction::new("unreadable", String::new());
    };

    Extraction::new(status, text.to_owned())
}

const MAX_OFFICE_PARTS: usize = 4096;
const MAX_XML_DEPTH: usize = 128;

fn office_text_part(name: &str) -> bool {
    matches!(
        name,
        "word/document.xml" | "xl/sharedStrings.xml" | "content.xml"
    ) || (name.starts_with("ppt/slides/slide") || name.starts_with("xl/worksheets/sheet"))
        && name.ends_with(".xml")
        && name.matches('/').count() == 2
}

fn office(bytes: &[u8]) -> Option<Extraction> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;

    if archive.len() > MAX_OFFICE_PARTS {
        return None;
    }

    let mut parts: Vec<_> = archive
        .file_names_raw()
        .filter_map(|name| std::str::from_utf8(name).ok())
        .filter(|name| office_text_part(name))
        .map(str::to_owned)
        .collect();
    if parts.is_empty() {
        return Some(Extraction::new("unsupported", String::new()));
    }

    parts.sort_by(|a, b| a.len().cmp(&b.len()).then(a.cmp(b)));
    let mut output = String::new();
    let mut remaining = XML_LIMIT;

    for name in parts {
        let file = archive.by_name(&name).ok()?;

        if file.size() > remaining {
            return Some(Extraction::new("partial", output));
        }

        let mut xml = String::new();

        file.take(remaining + 1).read_to_string(&mut xml).ok()?;
        remaining = remaining.checked_sub(xml.len() as u64)?;

        if !append_xml_text(&xml, &mut output)? {
            return Some(Extraction::new("partial", output));
        }
    }

    Some(Extraction::new("ready", output))
}

#[derive(Default)]
struct TextScan {
    depth: usize,
    text_depth: Option<usize>,
}

impl TextScan {
    fn open(&mut self, holds_text: bool) -> Option<()> {
        self.depth += 1;

        if self.depth > MAX_XML_DEPTH {
            return None;
        }

        if self.text_depth.is_none() && holds_text {
            self.text_depth = Some(self.depth);
        }

        Some(())
    }

    fn close(&mut self, ends_line: bool, output: &mut String) -> Option<()> {
        if ends_line {
            output.push('\n');
        }

        if self.text_depth == Some(self.depth) {
            self.text_depth = None;
        }

        self.depth = self.depth.checked_sub(1)?;

        Some(())
    }

    fn in_text(&self) -> bool {
        self.text_depth.is_some()
    }
}

fn append_xml_text(xml: &str, output: &mut String) -> Option<bool> {
    let mut reader = Reader::from_str(xml);
    let mut scan = TextScan::default();

    loop {
        match reader.read_event().ok()? {
            Event::Start(e) => {
                scan.open(matches!(e.local_name().as_ref(), "t" | "v" | "p" | "h"))?
            }
            Event::End(e) => {
                let ends_line = matches!(e.local_name().as_ref(), "p" | "h" | "si" | "c");

                scan.close(ends_line, output)?
            }
            Event::Empty(e) if matches!(e.local_name().as_ref(), "tab" | "br" | "s") => {
                output.push(' ')
            }
            Event::Text(t) if scan.in_text() => output.push_str(&t.xml10_content()),
            Event::CData(t) if scan.in_text() => output.push_str(&t.xml10_content()),
            Event::GeneralRef(r) if scan.in_text() => push_reference(&r, output)?,
            Event::DocType(_) => return None,
            Event::Eof => return Some(true),
            _ => {}
        }

        if output.len() >= TEXT_LIMIT {
            output.truncate(output.floor_char_boundary(TEXT_LIMIT));

            return Some(false);
        }
    }
}

fn push_reference(reference: &quick_xml::events::BytesRef, output: &mut String) -> Option<()> {
    if let Some(c) = reference.resolve_char_ref().ok()? {
        output.push(c);
    } else {
        output.push_str(quick_xml::escape::resolve_xml_entity(
            &reference.xml10_content(),
        )?);
    }

    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};

    const WIDTH: u32 = 600;
    const HEIGHT: u32 = 400;
    const BITMAP_HEADER: u32 = 54;

    fn bitmap() -> Vec<u8> {
        let pixels = WIDTH * HEIGHT * 3;
        let mut bytes = b"BM".to_vec();

        bytes.extend((BITMAP_HEADER + pixels).to_le_bytes());
        bytes.extend([0; 4]);
        bytes.extend(BITMAP_HEADER.to_le_bytes());
        bytes.extend(40u32.to_le_bytes());
        bytes.extend(WIDTH.to_le_bytes());
        bytes.extend(HEIGHT.to_le_bytes());
        bytes.extend(1u16.to_le_bytes());
        bytes.extend(24u16.to_le_bytes());
        bytes.extend([0; 24]);
        bytes.extend(std::iter::repeat_n(200u8, pixels as usize));

        bytes
    }

    fn longest_edge(jpeg: &[u8]) -> usize {
        let frame = jpeg
            .windows(2)
            .position(|w| w[0] == 0xff && matches!(w[1], 0xc0 | 0xc2))
            .unwrap();
        let size = |at: usize| usize::from(u16::from_be_bytes([jpeg[at], jpeg[at + 1]]));

        size(frame + 5).max(size(frame + 7))
    }

    fn text_pdf(rotate: u32) -> Vec<u8> {
        let stream = "BT /F1 24 Tf 72 700 Td (Rechnung Betrag 4711) Tj ET";
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate {rotate} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
            ),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
            format!(
                "<< /Length {} >>\nstream\n{stream}\nendstream",
                stream.len()
            ),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();

        for (number, body) in (1..).zip(&objects) {
            offsets.push(pdf.len());
            pdf.extend(format!("{number} 0 obj\n{body}\nendobj\n").bytes());
        }

        let table = pdf.len();
        let size = objects.len() + 1;

        pdf.extend(format!("xref\n0 {size}\n0000000000 65535 f \n").bytes());

        for offset in offsets {
            pdf.extend(format!("{offset:010} 00000 n \n").bytes());
        }

        pdf.extend(
            format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{table}\n%%EOF\n").bytes(),
        );

        pdf
    }

    fn assert_near(found: &[FoundBox], expected: FoundBox, tolerance: f32) {
        assert_eq!(found.len(), 1, "{found:?}");
        let close = found[0]
            .iter()
            .zip(expected)
            .all(|(value, wanted)| (value - wanted).abs() < tolerance);
        assert!(close, "{found:?} is not near {expected:?}");
    }

    #[test]
    fn the_found_word_is_boxed_on_the_page_as_shown() {
        let word = [0.307, 0.088, 0.116, 0.035];

        assert_near(&found_boxes(&text_pdf(0), 0, "betrag"), word, 0.02);
        let turned = [1.0 - word[1] - word[3], word[0], word[3], word[2]];

        assert_near(&found_boxes(&text_pdf(90), 0, "BETRAG"), turned, 0.02);
        assert!(found_boxes(&text_pdf(0), 0, "fehlt").is_empty());
        assert!(found_boxes(&text_pdf(0), 1, "betrag").is_empty());
    }

    #[test]
    fn the_found_word_is_boxed_in_a_photo_by_text_recognition() {
        let (_, jpeg) = preview(&text_pdf(0), 0, PREVIEW_EDGE).unwrap();
        let photo = STANDARD.decode(jpeg).unwrap();

        assert_near(
            &found_boxes(&photo, 0, "Betrag"),
            [0.307, 0.088, 0.116, 0.035],
            0.04,
        );
    }

    #[test]
    fn a_thumbnail_is_scaled_down_and_a_preview_is_not() {
        let image = bitmap();
        let edge_of = |edge| {
            let (pages, jpeg) = preview(&image, 0, edge).unwrap();

            assert_eq!(pages, 1);

            longest_edge(&STANDARD.decode(jpeg).unwrap())
        };

        assert_eq!(edge_of(THUMBNAIL_EDGE), THUMBNAIL_EDGE);
        assert_eq!(edge_of(PREVIEW_EDGE), WIDTH as usize);
        assert!(preview(&image, 0, PREVIEW_EDGE + 1).is_none());
        assert!(preview(&image, 0, 0).is_none());
    }
}
