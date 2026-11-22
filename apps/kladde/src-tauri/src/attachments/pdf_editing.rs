use crate::{
    attachments::text_and_previews::is_pdf,
    attachments::{
        encrypted_files::{self, Saved},
        file_reading::{FileReadError, file_bytes},
    },
    notebook::vault::Vault,
};

use serde::{Deserialize, Serialize};
use std::{collections::HashSet, ffi::c_void};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

unsafe extern "C" {
    fn kladde_pdf_pages(
        bytes: *const u8,
        length: usize,
        sizes: *mut f64,
        capacity: usize,
        editable: *mut bool,
    ) -> usize;

    fn kladde_pdf_edit(
        bytes: *const u8,
        length: usize,
        plan: *const u8,
        plan_length: usize,
        result: *mut c_void,
        copy: unsafe extern "C" fn(*mut c_void, *const u8, usize),
    ) -> i32;
}

const MAX_PAGES: usize = 5000;
const MAX_MARKS: usize = 20_000;
const MAX_POINTS: usize = 500_000;
const MAX_TEXT: usize = 4000;
const MAX_COORDINATE: f64 = 100_000.0;
const MAX_WIDTH: f64 = 1000.0;
const TURNS: [u16; 4] = [0, 90, 180, 270];
const FALLBACK_SIZE: [f64; 2] = [595.0, 842.0];
const EDIT_PROTECTED: i32 = 2;
const EDIT_INVALID: i32 = 3;
const EDIT_UNWRITABLE: i32 = 4;
const UNREADABLE: &str = "PDF could not be opened";
const PROTECTED: &str = "PDF is protected against changes";
const INVALID: &str = "Invalid PDF edit";
const UNWRITABLE: &str = "PDF could not be saved";
const UNAVAILABLE: &str = "PDF unavailable";

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Pen,
    Marker,
    Rect,
    Arrow,
    Text,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Mark {
    kind: Kind,
    color: String,
    width: f64,
    points: Vec<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

impl Drop for Mark {
    fn drop(&mut self) {
        self.text.zeroize();
        self.points.zeroize();
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PageEdit {
    source: usize,
    turn: u16,
    marks: Vec<Mark>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PdfEdit {
    pages: Vec<PageEdit>,
}

#[derive(Serialize)]
pub struct PdfPages {
    sizes: Vec<[f64; 2]>,
    editable: bool,
}

fn valid_color(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_point([x, y]: &[f64; 2]) -> bool {
    [x, y]
        .iter()
        .all(|value| value.is_finite() && value.abs() <= MAX_COORDINATE)
}

fn fitting_points(kind: Kind, count: usize) -> bool {
    match kind {
        Kind::Pen | Kind::Marker => count > 0,
        Kind::Rect | Kind::Arrow => count == 2,
        Kind::Text => count == 1,
    }
}

fn valid_text(kind: Kind, text: Option<&str>) -> bool {
    match (kind, text) {
        (Kind::Text, Some(text)) => {
            !text.trim().is_empty() && text.chars().count() <= MAX_TEXT && !text.contains('\0')
        }
        (Kind::Text, None) | (_, Some(_)) => false,
        (_, None) => true,
    }
}

impl Mark {
    fn is_valid(&self) -> bool {
        valid_color(&self.color)
            && self.width.is_finite()
            && self.width > 0.0
            && self.width <= MAX_WIDTH
            && fitting_points(self.kind, self.points.len())
            && self.points.iter().all(valid_point)
            && valid_text(self.kind, self.text.as_deref())
    }
}

impl PdfEdit {
    fn check(&self) -> Result<(), String> {
        let marks = || self.pages.iter().flat_map(|page| &page.marks);
        let fits = !self.pages.is_empty()
            && self.pages.len() <= MAX_PAGES
            && marks().count() <= MAX_MARKS
            && marks().map(|mark| mark.points.len()).sum::<usize>() <= MAX_POINTS;
        let mut sources = HashSet::new();
        let pages_valid = self.pages.iter().all(|page| {
            page.source < MAX_PAGES
                && TURNS.contains(&page.turn)
                && sources.insert(page.source)
                && page.marks.iter().all(Mark::is_valid)
        });

        if fits && pages_valid {
            Ok(())
        } else {
            Err(INVALID.into())
        }
    }
}

fn page_size(size: &[f64; 2]) -> [f64; 2] {
    let fits = |side: &f64| side.is_finite() && *side > 0.0 && *side <= MAX_COORDINATE;

    if size.iter().all(fits) {
        *size
    } else {
        FALLBACK_SIZE
    }
}

fn pages_of(bytes: &[u8]) -> Result<PdfPages, String> {
    if !is_pdf(bytes) {
        return Err(UNREADABLE.into());
    }

    let mut sizes = vec![0.0; MAX_PAGES * 2];
    let mut editable = false;
    let count = unsafe {
        kladde_pdf_pages(
            bytes.as_ptr(),
            bytes.len(),
            sizes.as_mut_ptr(),
            MAX_PAGES,
            &raw mut editable,
        )
    };

    if count == 0 {
        return Err(UNREADABLE.into());
    }

    Ok(PdfPages {
        sizes: sizes
            .as_chunks::<2>()
            .0
            .iter()
            .take(count)
            .map(page_size)
            .collect(),
        editable: editable && count <= MAX_PAGES,
    })
}

fn edited(bytes: &[u8], plan: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
    unsafe extern "C" fn copy(result: *mut c_void, data: *const u8, length: usize) {
        if data.is_null() || length == 0 {
            return;
        }

        let output = unsafe { &mut *result.cast::<Zeroizing<Vec<u8>>>() };

        output.reserve_exact(length);
        output.extend_from_slice(unsafe { std::slice::from_raw_parts(data, length) });
    }

    if !is_pdf(bytes) {
        return Err(UNREADABLE.into());
    }

    let mut output = Zeroizing::new(Vec::new());
    let status = unsafe {
        kladde_pdf_edit(
            bytes.as_ptr(),
            bytes.len(),
            plan.as_ptr(),
            plan.len(),
            (&raw mut output).cast(),
            copy,
        )
    };

    match status {
        0 if !output.is_empty() => Ok(output),
        EDIT_PROTECTED => Err(PROTECTED.into()),
        EDIT_INVALID => Err(INVALID.into()),
        EDIT_UNWRITABLE => Err(UNWRITABLE.into()),
        _ => Err(UNREADABLE.into()),
    }
}

#[tauri::command]
pub async fn pdf_pages(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    doc: Uuid,
    file: Uuid,
) -> Result<PdfPages, String> {
    let bytes = file_bytes(&app, &vault, space, doc, file)
        .await
        .map_err(FileReadError::reason)?;
    tokio::task::spawn_blocking(move || pages_of(&bytes))
        .await
        .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
pub async fn edit_pdf(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    doc: Uuid,
    file: Uuid,
    edit: PdfEdit,
) -> Result<Saved, String> {
    edit.check()?;
    let plan = Zeroizing::new(serde_json::to_vec(&edit).map_err(|_| INVALID)?);
    let bytes = file_bytes(&app, &vault, space, doc, file)
        .await
        .map_err(FileReadError::reason)?;
    tokio::task::spawn_blocking(move || {
        let output = edited(&bytes, &plan)?;
        let vault = app.state::<Vault>();
        let (parts, size) =
            encrypted_files::store_parts(&app, &vault, space, doc, &mut output.as_slice())?;

        Ok(Saved { parts, size })
    })
    .await
    .map_err(|_| UNAVAILABLE)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_pdf(pages: &[(u32, u32, u32)]) -> Vec<u8> {
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            String::new(),
        ];
        let mut kids = Vec::new();

        for (width, height, rotate) in pages {
            kids.push(format!("{} 0 R", objects.len() + 1));
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] /Rotate {rotate} >>"
            ));
        }

        objects[1] = format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.join(" "),
            pages.len()
        );
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();

        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend(format!("{} 0 obj\n{object}\nendobj\n", index + 1).bytes());
        }

        let table = pdf.len();

        pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());

        for offset in offsets {
            pdf.extend(format!("{offset:010} 00000 n \n").bytes());
        }

        pdf.extend(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{table}\n%%EOF\n",
                objects.len() + 1
            )
            .bytes(),
        );

        pdf
    }

    fn pen(points: Vec<[f64; 2]>) -> Mark {
        Mark {
            kind: Kind::Pen,
            color: "#e03e3e".into(),
            width: 3.0,
            points,
            text: None,
        }
    }

    fn page(source: usize, turn: u16, marks: Vec<Mark>) -> PageEdit {
        PageEdit {
            source,
            turn,
            marks,
        }
    }

    #[test]
    fn page_sizes_follow_rotation() {
        let pdf = minimal_pdf(&[(600, 800, 0), (600, 800, 90)]);
        let pages = pages_of(&pdf).unwrap();

        assert_eq!(pages.sizes, vec![[600.0, 800.0], [800.0, 600.0]]);
        assert!(pages.editable);
        assert!(pages_of(b"not a pdf").is_err());
    }

    #[test]
    fn edits_reorder_delete_rotate_and_annotate() {
        let pdf = minimal_pdf(&[(600, 800, 0), (500, 700, 0), (400, 300, 0)]);
        let edit = PdfEdit {
            pages: vec![
                page(2, 90, vec![pen(vec![[10.0, 10.0], [50.0, 40.0]])]),
                page(0, 0, Vec::new()),
            ],
        };

        edit.check().unwrap();
        let output = edited(&pdf, &serde_json::to_vec(&edit).unwrap()).unwrap();
        let pages = pages_of(&output).unwrap();

        assert_eq!(pages.sizes, vec![[300.0, 400.0], [600.0, 800.0]]);
    }

    #[test]
    fn native_edit_rejects_sources_beyond_the_document() {
        let pdf = minimal_pdf(&[(600, 800, 0)]);
        let plan = serde_json::to_vec(&PdfEdit {
            pages: vec![page(3, 0, Vec::new())],
        })
        .unwrap();

        assert_eq!(edited(&pdf, &plan).err().as_deref(), Some(INVALID));
    }

    #[test]
    fn invalid_edits_are_refused_before_reading() {
        let text = |text: Option<&str>| Mark {
            kind: Kind::Text,
            color: "#000000".into(),
            width: 16.0,
            points: vec![[1.0, 1.0]],
            text: text.map(Into::into),
        };

        let refused = |pages: Vec<PageEdit>| PdfEdit { pages }.check().is_err();

        assert!(refused(Vec::new()));
        assert!(refused(vec![page(0, 45, Vec::new())]));
        assert!(refused(vec![
            page(0, 0, Vec::new()),
            page(0, 90, Vec::new())
        ]));
        assert!(refused(vec![page(0, 0, vec![pen(Vec::new())])]));
        assert!(refused(vec![page(0, 0, vec![pen(vec![[f64::NAN, 1.0]])])]));
        assert!(refused(vec![page(0, 0, vec![pen(vec![[1e9, 1.0]])])]));
        assert!(refused(vec![page(0, 0, vec![text(None)])]));
        assert!(refused(vec![page(0, 0, vec![text(Some("  "))])]));
        assert!(refused(vec![page(0, 0, vec![text(Some("a\0b"))])]));
        let mut colored = pen(vec![[1.0, 1.0]]);

        colored.color = "#E03E3E".into();
        assert!(refused(vec![page(0, 0, vec![colored])]));
        let mut labelled = pen(vec![[1.0, 1.0]]);

        labelled.text = Some("x".into());
        assert!(refused(vec![page(0, 0, vec![labelled])]));
        assert!(!refused(vec![page(0, 270, vec![text(Some("Hallo"))])]));
    }

    #[test]
    fn unknown_fields_are_refused() {
        let parsed = serde_json::from_str::<PdfEdit>(
            r#"{"pages":[{"source":0,"turn":0,"marks":[],"extra":1}]}"#,
        );

        assert!(parsed.is_err());
    }
}
