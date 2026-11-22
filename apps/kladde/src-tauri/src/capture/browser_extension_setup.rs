use crate::capture::{browser_extension_host, clip_inbox};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

const HOST_NAME: &str = "de.kladde.clipper";
const EXTENSION_FOLDER: &str = "browser-extension";
const BROWSERS: &[(&str, &str)] = &[
    ("Google Chrome", "Google/Chrome"),
    ("Microsoft Edge", "Microsoft Edge"),
    ("Brave", "BraveSoftware/Brave-Browser"),
    ("Vivaldi", "Vivaldi"),
];
const UNSTABLE_LOCATIONS: &[&str] = &["/AppTranslocation/", "/Volumes/"];
const EXTENSION_FILES: &[(&str, &[u8])] = &[
    (
        "manifest.json",
        include_bytes!("../../../browser-extension/manifest.json"),
    ),
    (
        "background.js",
        include_bytes!("../../../browser-extension/background.js"),
    ),
    (
        "collect.js",
        include_bytes!("../../../browser-extension/collect.js"),
    ),
    (
        "popup.html",
        include_bytes!("../../../browser-extension/popup.html"),
    ),
    (
        "popup.css",
        include_bytes!("../../../browser-extension/popup.css"),
    ),
    (
        "popup.js",
        include_bytes!("../../../browser-extension/popup.js"),
    ),
    (
        "_locales/de/messages.json",
        include_bytes!("../../../browser-extension/_locales/de/messages.json"),
    ),
    (
        "_locales/en/messages.json",
        include_bytes!("../../../browser-extension/_locales/en/messages.json"),
    ),
    ("icons/32.png", include_bytes!("../../icons/32x32.png")),
    ("icons/128.png", include_bytes!("../../icons/128x128.png")),
];

#[derive(Serialize)]
pub struct Browser {
    name: &'static str,
    connected: bool,
}

#[derive(Serialize)]
pub struct Status {
    browsers: Vec<Browser>,
    folder: String,
    ready: bool,
}

fn support_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
        .map(|home| home.join("Library/Application Support"))
        .ok_or_else(|| "Home folder unavailable".into())
}

fn extension_dir(support: &Path) -> PathBuf {
    support.join(clip_inbox::IDENTIFIER).join(EXTENSION_FOLDER)
}

fn host_file(support: &Path, browser: &str) -> PathBuf {
    support
        .join(browser)
        .join("NativeMessagingHosts")
        .join(format!("{HOST_NAME}.json"))
}

fn installed(support: &Path) -> impl Iterator<Item = (&'static str, PathBuf)> + '_ {
    BROWSERS
        .iter()
        .filter(|(_, folder)| support.join(folder).is_dir())
        .map(|(name, folder)| (*name, host_file(support, folder)))
}

fn host_program() -> Result<PathBuf, String> {
    let program = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|_| "Kladde location unavailable")?;
    let text = program.to_str().ok_or("Kladde location unavailable")?;

    if UNSTABLE_LOCATIONS.iter().any(|part| text.contains(part)) {
        return Err("Move Kladde to the Applications folder first".into());
    }

    Ok(program)
}

fn host_manifest(program: &Path) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(&serde_json::json!({
        "name": HOST_NAME,
        "description": "Kladde Web Clipper",
        "path": program,
        "type": "stdio",
        "allowed_origins": [browser_extension_host::origin()],
    }))
    .map_err(|_| "Kladde location unavailable".into())
}

fn connected(path: &Path, manifest: &[u8]) -> bool {
    fs::read(path).is_ok_and(|current| current == manifest)
}

fn write_extension(dir: &Path) -> Result<(), String> {
    let failed = |_| "Extension folder could not be written".to_string();

    if dir.exists() {
        fs::remove_dir_all(dir).map_err(failed)?;
    }

    for (name, bytes) in EXTENSION_FILES {
        let path = dir.join(name);

        fs::create_dir_all(path.parent().unwrap_or(dir)).map_err(failed)?;
        fs::write(&path, bytes).map_err(failed)?;
    }

    Ok(())
}

fn write_hosts<'a>(
    targets: impl Iterator<Item = &'a PathBuf>,
    manifest: &[u8],
) -> Result<(), String> {
    for path in targets {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| "Browser folder not writable")?;
        }

        fs::write(path, manifest).map_err(|_| "Browser folder not writable")?;
    }

    Ok(())
}

fn status(support: &Path) -> Status {
    let manifest = host_program().and_then(|program| host_manifest(&program));
    let browsers: Vec<Browser> = installed(support)
        .map(|(name, path)| Browser {
            name,
            connected: manifest.as_ref().is_ok_and(|m| connected(&path, m)),
        })
        .collect();
    let folder = extension_dir(support);

    Status {
        ready: folder.is_dir() && browsers.iter().any(|b| b.connected),
        folder: folder.to_string_lossy().into_owned(),
        browsers,
    }
}

#[cfg(target_os = "macos")]
pub fn refresh() {
    let Ok(support) = support_dir() else { return };
    let registered: Vec<PathBuf> = installed(&support)
        .map(|(_, path)| path)
        .filter(|path| path.is_file())
        .collect();
    if registered.is_empty() {
        return;
    }

    let Ok(manifest) = host_program().and_then(|program| host_manifest(&program)) else {
        return;
    };

    let _ = write_hosts(registered.iter(), &manifest);
    let _ = write_extension(&extension_dir(&support));
}

#[tauri::command]
pub fn clipper_status() -> Result<Status, String> {
    Ok(status(&support_dir()?))
}

#[tauri::command]
pub fn clipper_setup() -> Result<Status, String> {
    if !cfg!(target_os = "macos") {
        return Err("Web clipper unavailable on this device".into());
    }

    let support = support_dir()?;
    let manifest = host_manifest(&host_program()?)?;

    clip_inbox::ensure_key()?;
    write_extension(&extension_dir(&support))?;
    let targets: Vec<PathBuf> = installed(&support).map(|(_, path)| path).collect();

    write_hosts(targets.iter(), &manifest)?;

    Ok(status(&support))
}

#[tauri::command]
pub fn clipper_remove() -> Result<Status, String> {
    let support = support_dir()?;

    for (_, path) in installed(&support) {
        if path.is_file() {
            fs::remove_file(&path).map_err(|_| "Browser folder not writable")?;
        }
    }

    let folder = extension_dir(&support);

    if folder.exists() {
        fs::remove_dir_all(&folder).map_err(|_| "Extension folder could not be removed")?;
    }

    Ok(status(&support))
}

#[tauri::command]
pub fn clipper_reveal() -> Result<(), String> {
    let folder = extension_dir(&support_dir()?);

    if !folder.is_dir() {
        return Err("Extension folder missing".into());
    }

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&folder)
        .status()
        .map_err(|_| "Finder unavailable")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("kladde-clipper-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        fs::create_dir_all(&dir).unwrap();

        dir
    }

    #[test]
    fn host_manifest_allows_only_the_kladde_extension() {
        let bytes =
            host_manifest(Path::new("/Applications/Kladde.app/Contents/MacOS/kladde")).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(value["name"], HOST_NAME);
        assert_eq!(value["type"], "stdio");
        assert_eq!(
            value["path"],
            "/Applications/Kladde.app/Contents/MacOS/kladde"
        );
        assert_eq!(
            value["allowed_origins"],
            serde_json::json!([format!(
                "chrome-extension://{}/",
                browser_extension_host::EXTENSION_ID
            )])
        );
    }

    #[test]
    fn registers_only_installed_browsers() {
        let support = scratch("browsers");

        fs::create_dir_all(support.join("Microsoft Edge")).unwrap();
        let found: Vec<_> = installed(&support).collect();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "Microsoft Edge");
        write_hosts(found.iter().map(|(_, path)| path), b"{}").unwrap();
        assert!(connected(&found[0].1, b"{}"));
        assert!(!connected(&found[0].1, b"[]"));
        assert!(!support.join("Google/Chrome").exists());
        fs::remove_dir_all(&support).unwrap();
    }

    #[test]
    fn writes_a_complete_extension_and_drops_stale_files() {
        let dir = scratch("extension").join(EXTENSION_FOLDER);

        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("old.js"), b"x").unwrap();
        write_extension(&dir).unwrap();
        assert!(!dir.join("old.js").exists());

        for (name, bytes) in EXTENSION_FILES {
            assert_eq!(fs::read(dir.join(name)).unwrap(), *bytes, "{name}");
        }

        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn extension_references_only_bundled_files() {
        let manifest: serde_json::Value = serde_json::from_slice(EXTENSION_FILES[0].1).unwrap();
        let bundled = |name: &str| EXTENSION_FILES.iter().any(|(file, _)| *file == name);

        for path in [
            &manifest["background"]["service_worker"],
            &manifest["action"]["default_popup"],
            &manifest["icons"]["32"],
            &manifest["icons"]["128"],
        ] {
            assert!(bundled(path.as_str().unwrap()), "{path}");
        }

        let permissions = manifest["permissions"].as_array().unwrap();

        assert!(manifest.get("host_permissions").is_none());
        assert!(!permissions.iter().any(|p| p == "<all_urls>" || p == "tabs"));
    }

    fn messages(name: &str) -> serde_json::Map<String, serde_json::Value> {
        let file = EXTENSION_FILES
            .iter()
            .find(|(file, _)| *file == name)
            .unwrap();
        serde_json::from_slice(file.1).unwrap()
    }

    #[test]
    fn translations_use_valid_and_matching_keys() {
        let german = messages("_locales/de/messages.json");
        let english = messages("_locales/en/messages.json");

        assert_eq!(
            german.keys().collect::<Vec<_>>(),
            english.keys().collect::<Vec<_>>()
        );

        for key in german.keys() {
            assert!(
                key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
                "{key}"
            );
        }

        let refusals = [
            clip_inbox::Refusal::NotSetUp,
            clip_inbox::Refusal::Invalid,
            clip_inbox::Refusal::Full,
            clip_inbox::Refusal::Storage,
        ];

        for refusal in refusals {
            assert!(german.contains_key(&format!("error_{}", refusal.code())));
        }

        let manifest = String::from_utf8_lossy(EXTENSION_FILES[0].1);

        for part in manifest.split("__MSG_").skip(1) {
            let key = part.split("__").next().unwrap();

            assert!(german.contains_key(key), "{key}");
        }
    }
}
