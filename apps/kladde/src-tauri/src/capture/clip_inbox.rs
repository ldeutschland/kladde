#[cfg(not(target_os = "ios"))]
use kladde_crypto::Wrapped;
use kladde_crypto::{self as c, Purpose};

#[cfg(not(target_os = "ios"))]
use kladde_protocol::decode_attachment;
use kladde_protocol::encode;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::SystemTime,
};

use uuid::Uuid;
use zeroize::Zeroizing;

pub const IDENTIFIER: &str = "de.kladde.notebook";
pub const MAX_MESSAGE: usize = 48 * 1024 * 1024;
pub const MAX_IMAGE: usize = 10 * 1024 * 1024;

#[cfg(not(target_os = "ios"))]
const MAX_STORED: usize = MAX_MESSAGE + 64 * 1024;
const VERSION: u8 = 1;
const KEY_NAME: &str = "clip-inbox-v1";
const FOLDER: &str = "clip-inbox";
const SUFFIX: &str = ".clip";
const PARTIAL: &str = ".part";
const MAX_PENDING: usize = 100;
const MAX_TITLE: usize = 1000;
const MAX_NOTE: usize = 4000;
const MAX_HTML: usize = 5 * 1024 * 1024;
const MAX_IMAGES: usize = 20;
const MAX_ADDRESS: usize = 2048;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Article,
    Page,
    Selection,
    Image,
    Link,
    Screenshot,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Picture {
    pub url: String,
    pub data: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub version: u8,
    pub kind: Kind,
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub html: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub images: Vec<Picture>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    NotSetUp,
    Invalid,
    Full,
    Storage,
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotSetUp => "not_set_up",
            Self::Invalid => "invalid",
            Self::Full => "full",
            Self::Storage => "storage",
        }
    }
}

fn short_text(text: &str, limit: usize) -> bool {
    text.chars().count() <= limit
}

fn plain_address(text: &str) -> bool {
    text.len() <= MAX_ADDRESS && !text.chars().any(char::is_control)
}

impl Picture {
    fn fits(&self) -> bool {
        plain_address(&self.url)
            && !self.data.is_empty()
            && self.data.len() <= MAX_IMAGE.div_ceil(3) * 4
    }
}

impl Message {
    pub fn parse(bytes: &[u8]) -> Result<Self, Refusal> {
        let message: Self = serde_json::from_slice(bytes).map_err(|_| Refusal::Invalid)?;

        message.check()?;

        Ok(message)
    }

    fn check(&self) -> Result<(), Refusal> {
        let valid = self.version == VERSION
            && kladde_clip::source_address(&self.url).is_ok()
            && short_text(&self.title, MAX_TITLE)
            && short_text(&self.note, MAX_NOTE)
            && self.html.len() <= MAX_HTML
            && self.has_html() != self.html.is_empty()
            && self.images.len() <= self.image_limit()
            && self.images.iter().all(Picture::fits)
            && self.target_fits();
        if valid { Ok(()) } else { Err(Refusal::Invalid) }
    }

    fn has_html(&self) -> bool {
        matches!(self.kind, Kind::Article | Kind::Page | Kind::Selection)
    }

    fn image_limit(&self) -> usize {
        match self.kind {
            Kind::Image | Kind::Screenshot => 1,
            Kind::Link => 0,
            _ => MAX_IMAGES,
        }
    }

    fn target_fits(&self) -> bool {
        let public = || kladde_clip::public_address(&self.target).is_ok();

        match self.kind {
            Kind::Link => public(),
            Kind::Image if self.images.len() == 1 => plain_address(&self.target),
            Kind::Image => public(),
            Kind::Screenshot => self.target.is_empty() && self.images.len() == 1,
            _ => self.target.is_empty(),
        }
    }
}

pub fn clip_folder() -> Result<PathBuf, Refusal> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
        .ok_or(Refusal::Storage)?;
    Ok(home
        .join("Library/Application Support")
        .join(IDENTIFIER)
        .join(FOLDER))
}

pub fn clip_key() -> Result<Zeroizing<Vec<u8>>, Refusal> {
    crate::platform::keychain::read_secret(IDENTIFIER, KEY_NAME)
        .map_err(|_| Refusal::Storage)?
        .filter(|key| key.len() == 32)
        .ok_or(Refusal::NotSetUp)
}

pub fn ensure_key() -> Result<(), String> {
    match clip_key() {
        Ok(_) => Ok(()),
        Err(Refusal::NotSetUp) => {
            crate::platform::keychain::write_secret(IDENTIFIER, KEY_NAME, c::key().as_ref())
        }
        Err(_) => Err("Keychain unavailable".into()),
    }
}

fn clip_path(dir: &Path, id: Uuid) -> PathBuf {
    dir.join(format!("{id}{SUFFIX}"))
}

fn waiting(dir: &Path) -> Vec<(SystemTime, Uuid)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut found: Vec<(SystemTime, Uuid)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = Uuid::parse_str(name.strip_suffix(SUFFIX)?).ok()?;
            let time = entry.metadata().ok()?.modified().ok()?;

            Some((time, id))
        })
        .collect();
    found.sort();

    found
}

#[cfg(not(target_os = "ios"))]
pub fn waiting_clips(dir: &Path) -> Vec<Uuid> {
    waiting(dir).into_iter().map(|(_, id)| id).collect()
}

pub fn store_clip(dir: &Path, key: &[u8], message: &Message) -> Result<Uuid, Refusal> {
    if waiting(dir).len() >= MAX_PENDING {
        return Err(Refusal::Full);
    }

    let id = Uuid::new_v4();
    let plain = Zeroizing::new(serde_json::to_vec(message).map_err(|_| Refusal::Invalid)?);
    let sealed = c::wrap(key, id, Purpose::Inbox, &plain).map_err(|_| Refusal::Storage)?;
    let bytes = encode(&sealed).map_err(|_| Refusal::Storage)?;

    write_private(dir, id, &bytes).map_err(|_| Refusal::Storage)?;

    Ok(id)
}

fn write_private(dir: &Path, id: Uuid, bytes: &[u8]) -> std::io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let partial = dir.join(format!("{id}{PARTIAL}"));
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&partial)?;
    out.write_all(bytes)?;
    out.sync_all()?;

    fs::rename(&partial, clip_path(dir, id))
}

#[cfg(not(target_os = "ios"))]
pub fn read_clip(dir: &Path, key: &[u8], id: Uuid) -> Result<Message, Refusal> {
    let path = clip_path(dir, id);
    let meta = fs::symlink_metadata(&path).map_err(|_| Refusal::Storage)?;

    if !meta.is_file() || meta.len() as usize > MAX_STORED {
        return Err(Refusal::Invalid);
    }

    let bytes = fs::read(&path).map_err(|_| Refusal::Storage)?;
    let sealed: Wrapped = decode_attachment(&bytes).map_err(|_| Refusal::Invalid)?;
    let plain = c::unwrap(key, id, Purpose::Inbox, &sealed).map_err(|_| Refusal::Invalid)?;

    Message::parse(&plain)
}

#[cfg(not(target_os = "ios"))]
pub fn remove_clip(dir: &Path, id: Uuid) -> Result<(), String> {
    match fs::remove_file(clip_path(dir, id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err("Clip could not be removed".into())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(kind: Kind) -> Message {
        Message {
            version: 1,
            kind,
            url: "https://example.com/a".into(),
            title: "Titel".into(),
            note: String::new(),
            html: "<p>Text</p>".into(),
            target: String::new(),
            images: Vec::new(),
        }
    }

    fn picture() -> Picture {
        Picture {
            url: "https://example.com/b.png".into(),
            data: "iVBORw0KGgo=".into(),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kladde-inbox-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        dir
    }

    #[test]
    fn accepts_well_formed_clips() {
        assert!(message(Kind::Article).check().is_ok());
        let mut image = message(Kind::Image);

        image.html.clear();
        image.target = "https://cdn.example.com/b.png".into();
        assert!(image.check().is_ok());
        image.target = "blob:https://example.com/1".into();
        image.images.push(picture());
        assert!(image.check().is_ok());
        let mut shot = message(Kind::Screenshot);

        shot.html.clear();
        shot.images.push(picture());
        assert!(shot.check().is_ok());
    }

    #[test]
    fn refuses_malformed_clips() {
        let cases: Vec<fn(&mut Message)> = vec![
            |m| m.version = 2,
            |m| m.url = "javascript:alert(1)".into(),
            |m| m.url = "https://user:pw@example.com".into(),
            |m| m.title = "x".repeat(MAX_TITLE + 1),
            |m| m.note = "x".repeat(MAX_NOTE + 1),
            |m| m.html.clear(),
            |m| m.html = "x".repeat(MAX_HTML + 1),
            |m| m.target = "https://example.com".into(),
            |m| m.images = (0..=MAX_IMAGES).map(|_| picture()).collect(),
            |m| {
                m.images = vec![Picture {
                    url: "a\nb".into(),
                    data: "AA==".into(),
                }]
            },
            |m| {
                m.images = vec![Picture {
                    url: String::new(),
                    data: String::new(),
                }]
            },
            |m| {
                m.images = vec![Picture {
                    url: String::new(),
                    data: "A".repeat(MAX_IMAGE.div_ceil(3) * 4 + 4),
                }]
            },
            |m| m.kind = Kind::Link,
            |m| {
                m.kind = Kind::Link;
                m.html.clear();
                m.target = "https://10.0.0.1/".into();
            },
            |m| {
                m.kind = Kind::Image;
                m.html.clear();
                m.target = "https://127.0.0.1/a.png".into();
            },
            |m| {
                m.kind = Kind::Screenshot;
                m.html.clear();
            },
        ];

        for (index, change) in cases.into_iter().enumerate() {
            let mut m = message(Kind::Article);

            change(&mut m);
            assert_eq!(m.check(), Err(Refusal::Invalid), "case {index}");
        }
    }

    #[test]
    fn refuses_unknown_fields_and_kinds() {
        let extra = br#"{"version":1,"kind":"article","url":"https://a.com","html":"x","run":"y"}"#;

        assert!(Message::parse(extra).is_err());
        let kind = br#"{"version":1,"kind":"script","url":"https://a.com"}"#;

        assert!(Message::parse(kind).is_err());
        let ok = br#"{"version":1,"kind":"link","url":"https://a.com","target":"https://b.com"}"#;

        assert!(Message::parse(ok).is_ok());
    }

    #[test]
    fn stores_encrypted_and_reads_back_in_order() {
        let dir = scratch("roundtrip");
        let key = [7u8; 32];
        let mut secret = message(Kind::Selection);

        secret.html = "<p>Kontostand geheim</p>".into();
        let first = store_clip(&dir, &key, &secret).unwrap();
        let second = store_clip(&dir, &key, &message(Kind::Page)).unwrap();
        let raw = fs::read(clip_path(&dir, first)).unwrap();

        assert!(!raw.windows(9).any(|w| w == b"Kontostan"));
        assert_eq!(waiting_clips(&dir), vec![first, second]);
        assert_eq!(read_clip(&dir, &key, first).unwrap().html, secret.html);
        assert_eq!(
            read_clip(&dir, &[8u8; 32], first).err(),
            Some(Refusal::Invalid)
        );
        fs::copy(clip_path(&dir, first), clip_path(&dir, second)).unwrap();
        assert_eq!(read_clip(&dir, &key, second).err(), Some(Refusal::Invalid));
        remove_clip(&dir, first).unwrap();
        remove_clip(&dir, first).unwrap();
        assert_eq!(waiting_clips(&dir), vec![second]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn files_are_private_and_the_queue_is_bounded() {
        use std::os::unix::fs::PermissionsExt;

        let dir = scratch("bounded");
        let key = [1u8; 32];
        let id = store_clip(&dir, &key, &message(Kind::Article)).unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;

        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&clip_path(&dir, id)), 0o600);

        for _ in 1..MAX_PENDING {
            store_clip(&dir, &key, &message(Kind::Article)).unwrap();
        }

        assert_eq!(
            store_clip(&dir, &key, &message(Kind::Article)),
            Err(Refusal::Full)
        );
        fs::write(dir.join("notes.txt"), b"x").unwrap();
        assert_eq!(waiting_clips(&dir).len(), MAX_PENDING);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn identifier_matches_the_app_configuration() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], IDENTIFIER);
    }
}
