use crate::capture::clip_inbox::{self, MAX_MESSAGE, Message, Refusal};
use serde_json::json;
use std::{
    io::{self, Read, Write},
    path::Path,
};

pub const EXTENSION_ID: &str = "nljnalhfenpdcbfpkdaeccopkdbfmpep";
const ORIGIN_SCHEME: &str = "chrome-extension://";

pub fn origin() -> String {
    format!("{ORIGIN_SCHEME}{EXTENSION_ID}/")
}

pub fn requested() -> Option<String> {
    std::env::args()
        .nth(1)
        .filter(|arg| arg.starts_with(ORIGIN_SCHEME))
}

#[cfg(target_os = "macos")]
const SIGNED_BROWSER: &str = r#"anchor apple generic and (identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV" or identifier "com.microsoft.edgemac" and certificate leaf[subject.OU] = "UBF8T346G9" or identifier "com.brave.Browser" and certificate leaf[subject.OU] = "KL8N8XSYF4" or identifier "com.vivaldi.Vivaldi" and certificate leaf[subject.OU] = "4XF3XNRN6Y")"#;

#[cfg(target_os = "macos")]
fn signed_browser(pid: u32) -> bool {
    use security_framework::os::macos::code_signing::{
        Flags, GuestAttributes, SecCode, SecRequirement,
    };

    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };

    let Ok(requirement) = SIGNED_BROWSER.parse::<SecRequirement>() else {
        return false;
    };

    let mut guest = GuestAttributes::new();

    guest.set_pid(pid);
    SecCode::copy_guest_with_attribues(None, &guest, Flags::NONE)
        .and_then(|code| code.check_validity(Flags::NONE, &requirement))
        .is_ok()
}

#[cfg(not(target_os = "macos"))]
fn signed_browser(_pid: u32) -> bool {
    false
}

fn launched_by_browser() -> bool {
    let parent = std::os::unix::process::parent_id();

    parent > 1 && signed_browser(parent) && std::os::unix::process::parent_id() == parent
}

pub fn serve(caller: &str) -> i32 {
    if caller != origin() || !launched_by_browser() {
        return 1;
    }

    let (mut input, mut output) = (io::stdin().lock(), io::stdout().lock());

    loop {
        let frame = match read_frame(&mut input) {
            Ok(Some(frame)) => frame,
            Ok(None) => return 0,
            Err(_) => return 1,
        };

        let reply = match clip_inbox::clip_folder().and_then(|dir| accept(&frame, &dir)) {
            Ok(()) => json!({ "ok": true }),
            Err(refusal) => json!({ "ok": false, "error": refusal.code() }),
        };

        if write_frame(&mut output, &reply).is_err() {
            return 1;
        }
    }
}

fn accept(frame: &[u8], dir: &Path) -> Result<(), Refusal> {
    let message = Message::parse(frame)?;

    clip_inbox::store_clip(dir, &clip_inbox::clip_key()?, &message).map(|_| ())
}

fn read_frame(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut size = [0u8; 4];

    match input.read_exact(&mut size) {
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        other => other?,
    }

    let size = u32::from_ne_bytes(size) as usize;

    if size == 0 || size > MAX_MESSAGE {
        return Err(io::ErrorKind::InvalidData.into());
    }

    let mut frame = vec![0u8; size];

    input.read_exact(&mut frame)?;

    Ok(Some(frame))
}

fn write_frame(output: &mut impl Write, value: &serde_json::Value) -> io::Result<()> {
    let body = serde_json::to_vec(value)?;
    let size = u32::try_from(body.len()).map_err(|_| io::ErrorKind::InvalidData)?;

    output.write_all(&size.to_ne_bytes())?;
    output.write_all(&body)?;

    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use sha2::{Digest, Sha256};

    fn framed(body: &[u8]) -> Vec<u8> {
        let mut bytes = (body.len() as u32).to_ne_bytes().to_vec();

        bytes.extend_from_slice(body);

        bytes
    }

    #[test]
    fn reads_consecutive_frames_until_end() {
        let mut stream = framed(b"{}");

        stream.extend(framed(b"[1]"));
        let mut input = io::Cursor::new(stream);

        assert_eq!(read_frame(&mut input).unwrap().unwrap(), b"{}");
        assert_eq!(read_frame(&mut input).unwrap().unwrap(), b"[1]");
        assert!(read_frame(&mut input).unwrap().is_none());
    }

    #[test]
    fn refuses_empty_oversized_and_truncated_frames() {
        assert!(read_frame(&mut io::Cursor::new(framed(b""))).is_err());
        let huge = ((MAX_MESSAGE + 1) as u32).to_ne_bytes().to_vec();

        assert!(read_frame(&mut io::Cursor::new(huge)).is_err());
        let mut cut = framed(b"abcdef");

        cut.truncate(7);
        assert!(read_frame(&mut io::Cursor::new(cut)).is_err());
    }

    #[test]
    fn replies_are_length_prefixed_json() {
        let mut out = Vec::new();

        write_frame(&mut out, &json!({ "ok": true })).unwrap();
        assert_eq!(out, framed(br#"{"ok":true}"#));
    }

    #[test]
    fn invalid_clips_never_reach_the_inbox() {
        let dir = std::env::temp_dir().join(format!("kladde-bridge-{}", std::process::id()));

        assert_eq!(accept(b"not json", &dir), Err(Refusal::Invalid));
        assert!(!dir.exists());
    }

    #[test]
    fn only_the_kladde_extension_may_connect() {
        assert_eq!(
            serve("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"),
            1
        );
        assert_eq!(serve("https://example.com/"), 1);
    }

    #[test]
    fn the_kladde_origin_alone_is_not_enough() {
        assert!(!signed_browser(std::process::id()));
        assert!(!launched_by_browser());
        assert_eq!(serve(&origin()), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_browser_requirement_compiles() {
        use security_framework::os::macos::code_signing::SecRequirement;

        assert!(SIGNED_BROWSER.parse::<SecRequirement>().is_ok());
    }

    #[test]
    fn extension_id_matches_the_manifest_key() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../browser-extension/manifest.json")).unwrap();
        let key = STANDARD.decode(manifest["key"].as_str().unwrap()).unwrap();
        let id: String = Sha256::digest(&key)[..16]
            .iter()
            .flat_map(|byte| [byte >> 4, byte & 0xf])
            .map(|nibble| (b'a' + nibble) as char)
            .collect();
        assert_eq!(id, EXTENSION_ID);
    }
}
