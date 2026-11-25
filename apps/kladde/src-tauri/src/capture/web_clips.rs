use crate::{
    attachments::encrypted_files,
    capture::clip_inbox::{self, Kind, Message, Picture, Refusal},
    notebook::vault::Vault,
};

use base64::{Engine, engine::general_purpose::STANDARD};
use kladde_clip::{Clip, Extract};
use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Serialize)]
pub struct StoredImage {
    id: Uuid,
    mime: &'static str,
    size: usize,
    sha256: String,
}

#[tauri::command]
pub async fn clip_page(address: String) -> Result<Clip, String> {
    kladde_clip::clip(&address).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clip_image(
    app: AppHandle,
    vault: State<'_, Vault>,
    space: Uuid,
    doc: Uuid,
    address: String,
) -> Result<StoredImage, String> {
    let image = kladde_clip::image(&address, kladde_protocol::MAX_ATTACHMENT_BYTES)
        .await
        .map_err(|e| e.to_string())?;
    let bytes = Zeroizing::new(image.bytes);
    let id = encrypted_files::store_new(&app, &vault, space, doc, &bytes)?;

    Ok(StoredImage {
        id,
        mime: image.mime,
        size: bytes.len(),
        sha256: hex::encode(encrypted_files::content_hash(&bytes)),
    })
}

#[derive(Serialize)]
pub struct Attachment {
    name: String,
    mime: &'static str,
    size: usize,
    data: String,
}

#[derive(Serialize)]
pub struct Inbound {
    clip: Clip,
    files: Vec<Option<Attachment>>,
}

const SCREENSHOT_NAME: &str = "screenshot.png";
const MAX_FILE_NAME: usize = 100;

fn file_name(address: &str) -> String {
    let segment = url::Url::parse(address)
        .ok()
        .and_then(|url| url.path_segments()?.next_back().map(str::to_string))
        .unwrap_or_default();
    let name: String = segment
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .take(MAX_FILE_NAME)
        .collect();
    if name.is_empty() {
        "image".into()
    } else {
        name
    }
}

fn attachment(picture: &Picture, name: String) -> Option<Attachment> {
    let bytes = Zeroizing::new(STANDARD.decode(&picture.data).ok()?);

    if bytes.len() > clip_inbox::MAX_IMAGE {
        return None;
    }

    Some(Attachment {
        name,
        mime: kladde_clip::image_type(&bytes)?,
        size: bytes.len(),
        data: picture.data.clone(),
    })
}

fn comparable(address: &str) -> Option<String> {
    let mut url = url::Url::parse(address).ok()?;

    if url.scheme() == "http" {
        url.set_scheme("https").ok()?;
    }

    Some(url.into())
}

fn page_files(clip: &Clip, pictures: &[Picture]) -> Vec<Option<Attachment>> {
    clip.images
        .iter()
        .map(|address| {
            pictures
                .iter()
                .find(|p| comparable(&p.url).as_deref() == Some(address.as_str()))
                .and_then(|p| attachment(p, file_name(address)))
        })
        .collect()
}

async fn inbound(message: Message) -> Result<Inbound, kladde_clip::Error> {
    let single = |name: String| vec![message.images.first().and_then(|p| attachment(p, name))];
    let (mut clip, files) = match message.kind {
        Kind::Article | Kind::Page | Kind::Selection => {
            let extract = if message.kind == Kind::Article {
                Extract::Article
            } else {
                Extract::Whole
            };

            let clip = kladde_clip::read_html(&message.html, &message.url, extract)?;
            let files = page_files(&clip, &message.images);

            (clip, files)
        }
        Kind::Link => (kladde_clip::clip(&message.target).await?, Vec::new()),
        Kind::Image => {
            let name = file_name(message.images.first().map_or(&message.target, |p| &p.url));
            let image = kladde_clip::public_address(&message.target).unwrap_or_default();
            let clip = kladde_clip::picture(&message.url, &message.title, image)?;

            (clip, single(name))
        }
        Kind::Screenshot => {
            let clip = kladde_clip::picture(&message.url, &message.title, String::new())?;

            (clip, single(SCREENSHOT_NAME.into()))
        }
    };

    kladde_clip::annotate(&mut clip, &message.note);

    Ok(Inbound { clip, files })
}

#[cfg(not(target_os = "ios"))]
mod queue {
    use crate::capture::clip_inbox::{self, Message, Refusal};
    use uuid::Uuid;

    fn clip_folder() -> Result<std::path::PathBuf, String> {
        clip_inbox::clip_folder().map_err(|_| "Inbox unavailable".into())
    }

    pub fn waiting_clips() -> Result<Vec<Uuid>, String> {
        Ok(clip_inbox::waiting_clips(&clip_folder()?))
    }

    pub fn read_clip(id: Uuid) -> Result<Result<Message, Refusal>, String> {
        let key = clip_inbox::clip_key().map_err(|_| "Web clipper not set up")?;

        Ok(clip_inbox::read_clip(&clip_folder()?, &key, id))
    }

    pub fn remove_clip(id: Uuid) -> Result<(), String> {
        clip_inbox::remove_clip(&clip_folder()?, id)
    }
}

#[cfg(target_os = "ios")]
mod queue {
    use crate::capture::clip_inbox::{Message, Refusal};
    use crate::capture::share_extension_inbox::{self, Folder};
    use uuid::Uuid;

    pub fn waiting_clips() -> Result<Vec<Uuid>, String> {
        share_extension_inbox::list(Folder::Clips)
    }

    pub fn read_clip(id: Uuid) -> Result<Result<Message, Refusal>, String> {
        let bytes = zeroize::Zeroizing::new(share_extension_inbox::read(Folder::Clips, Some(id))?);

        Ok(Message::parse(&bytes))
    }

    pub fn remove_clip(id: Uuid) -> Result<(), String> {
        share_extension_inbox::remove(Folder::Clips, id)
    }
}

#[tauri::command]
pub fn clip_inbox() -> Result<Vec<Uuid>, String> {
    queue::waiting_clips()
}

const MAX_ATTEMPTS: u8 = 3;
const CONFIRM_QUEUED: bool = cfg!(not(target_os = "ios"));

#[derive(Serialize)]
pub struct ClipPreview {
    kind: Kind,
    title: String,
    url: String,
    confirm: bool,
}

fn attempts_key(id: Uuid) -> String {
    format!("clip-attempts:{id}")
}

fn note_attempt(app: &AppHandle, vault: &Vault, id: Uuid) -> Result<Option<u8>, String> {
    vault.access(app, |store| {
        let key = attempts_key(id);
        let tried = store
            .state(&key)?
            .and_then(|value| value.first().copied())
            .unwrap_or(0);

        if tried >= MAX_ATTEMPTS {
            return Ok(None);
        }

        store.set_state(&key, &[tried + 1])?;

        Ok(Some(tried))
    })
}

fn set_attempts(app: &AppHandle, vault: &Vault, id: Uuid, tried: u8) {
    let _ = vault.access(app, |store| store.set_state(&attempts_key(id), &[tried]));
}

fn drop_clip(app: &AppHandle, vault: &Vault, id: Uuid) -> Result<(), String> {
    queue::remove_clip(id)?;
    let _ = vault.access(app, |store| store.clear_state(&attempts_key(id)));

    Ok(())
}

fn queued_message(app: &AppHandle, vault: &Vault, id: Uuid) -> Result<Message, String> {
    match queue::read_clip(id)? {
        Ok(message) => Ok(message),
        Err(Refusal::Invalid) => {
            drop_clip(app, vault, id)?;

            Err("Clip unreadable".into())
        }
        Err(_) => Err(format!("{RETRY}Inbox unavailable")),
    }
}

#[tauri::command]
pub fn clip_inbox_preview(
    app: AppHandle,
    vault: State<'_, Vault>,
    id: Uuid,
) -> Result<ClipPreview, String> {
    let message = queued_message(&app, &vault, id)?;

    Ok(ClipPreview {
        kind: message.kind,
        title: message.title,
        url: message.url,
        confirm: CONFIRM_QUEUED,
    })
}

#[tauri::command]
pub async fn clip_inbox_item(
    app: AppHandle,
    vault: State<'_, Vault>,
    id: Uuid,
) -> Result<Inbound, String> {
    let message = queued_message(&app, &vault, id)?;
    let Some(tried) = note_attempt(&app, &vault, id)? else {
        drop_clip(&app, &vault, id)?;

        return Err("Clip could not be processed".into());
    };

    match inbound(message).await {
        Ok(inbound) => Ok(inbound),
        Err(e) if worth_retrying(&e) => {
            set_attempts(&app, &vault, id, tried);

            Err(format!("{RETRY}{e}"))
        }
        Err(e) => {
            drop_clip(&app, &vault, id)?;

            Err(e.to_string())
        }
    }
}

const RETRY: &str = "retry:";

fn worth_retrying(error: &kladde_clip::Error) -> bool {
    match error {
        kladde_clip::Error::Network => true,
        kladde_clip::Error::Status(code) => *code == 429 || *code >= 500,
        _ => false,
    }
}

#[tauri::command]
pub fn finish_clip_inbox_item(
    app: AppHandle,
    vault: State<'_, Vault>,
    id: Uuid,
) -> Result<(), String> {
    drop_clip(&app, &vault, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUg==";

    fn picture(url: &str, data: &str) -> Picture {
        Picture {
            url: url.into(),
            data: data.into(),
        }
    }

    fn message(kind: Kind) -> Message {
        Message {
            version: 1,
            kind,
            url: "http://wiki.intern/seite".into(),
            title: "Bild".into(),
            note: String::new(),
            html: String::new(),
            target: String::new(),
            images: Vec::new(),
        }
    }

    fn run(message: Message) -> Inbound {
        tauri::async_runtime::block_on(inbound(message)).unwrap()
    }

    #[test]
    fn page_images_use_bytes_sent_by_the_browser() {
        let mut page = message(Kind::Page);

        page.html = r#"<p>Text</p><img src="http://cdn.example.com/a.png"><img src="https://cdn.example.com/b.png">"#.into();
        page.images = vec![
            picture("http://cdn.example.com/a.png", PNG),
            picture("https://cdn.example.com/b.png", "PHN2Zz4="),
        ];
        page.note = "Merken".into();
        let result = run(page);

        assert!(result.clip.markdown.starts_with("> Merken\n\nText"));
        assert_eq!(result.files.len(), 2);
        let first = result.files[0].as_ref().unwrap();

        assert_eq!(
            (first.name.as_str(), first.mime, first.size),
            ("a.png", "image/png", 16)
        );
        assert!(result.files[1].is_none());
    }

    #[test]
    fn single_images_and_screenshots_carry_their_file() {
        let mut image = message(Kind::Image);

        image.target = "blob:https://example.com/1".into();
        image.images = vec![picture("", PNG)];
        let result = run(image);

        assert_eq!(result.clip.images, [""]);
        assert_eq!(result.files[0].as_ref().unwrap().name, "image");
        let mut shot = message(Kind::Screenshot);

        shot.images = vec![picture("", PNG)];
        let result = run(shot);

        assert_eq!(result.files[0].as_ref().unwrap().name, SCREENSHOT_NAME);
        assert_eq!(result.clip.title, "Bild");
    }

    #[test]
    fn share_extension_messages_are_accepted() {
        let article = br#"{"version":1,"kind":"article","url":"https:\/\/example.com\/a?x=1","title":"Titel","note":"Merken","html":"<!doctype html><html><body><article><p>Text<\/p><\/article><\/body><\/html>","target":"","images":[]}"#;
        let message = Message::parse(article).unwrap();
        let result = run(message);

        assert!(result.clip.markdown.contains("Text"));
        assert!(result.clip.markdown.starts_with("> Merken"));
        let pictured = br#"{"version":1,"kind":"page","url":"https:\/\/intern.example.com\/a","title":"","note":"","html":"<p>Text<\/p><img src=\"https:\/\/intern.example.com\/geheim.png\">","target":"","images":[{"url":"https:\/\/intern.example.com\/geheim.png","data":"iVBORw0KGgoAAAANSUhEUg=="}]}"#;
        let result = run(Message::parse(pictured).unwrap());

        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].as_ref().unwrap().name, "geheim.png");
        let link = br#"{"version":1,"kind":"link","url":"https:\/\/example.com\/a","title":"","note":"","html":"","target":"https:\/\/example.com\/a","images":[]}"#;

        assert!(Message::parse(link).is_ok());
        let local = br#"{"version":1,"kind":"link","url":"http:\/\/192.168.0.2\/","title":"","note":"","html":"","target":"http:\/\/192.168.0.2\/","images":[]}"#;

        assert!(Message::parse(local).is_err());
    }

    #[test]
    fn only_temporary_failures_keep_a_clip() {
        assert!(worth_retrying(&kladde_clip::Error::Network));
        assert!(worth_retrying(&kladde_clip::Error::Status(503)));
        assert!(worth_retrying(&kladde_clip::Error::Status(429)));
        assert!(!worth_retrying(&kladde_clip::Error::Status(404)));
        assert!(!worth_retrying(&kladde_clip::Error::Empty));
    }

    #[test]
    fn public_images_without_bytes_are_fetched_later() {
        let mut image = message(Kind::Image);

        image.target = "https://cdn.example.com/x/foto%20(1).jpg".into();
        let result = run(image);

        assert_eq!(
            result.clip.images,
            ["https://cdn.example.com/x/foto%20(1).jpg"]
        );
        assert!(result.files[0].is_none());
        assert_eq!(
            file_name("https://cdn.example.com/x/foto%20(1).jpg"),
            "foto201.jpg"
        );
    }
}
