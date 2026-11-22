use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const MAX_LABEL: usize = 40;
const MAX_VIEW_KEY: usize = 80;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Tab {
    Home,
    Pages,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Top {
    None,
    Root,
    Page,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Labels {
    home: String,
    pages: String,
    search: String,
    ai: String,
    add: String,
    back: String,
    favorite: String,
    more: String,
    settings: String,
}

impl Labels {
    fn all(&self) -> [&String; 9] {
        [
            &self.home,
            &self.pages,
            &self.search,
            &self.ai,
            &self.add,
            &self.back,
            &self.favorite,
            &self.more,
            &self.settings,
        ]
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Chrome {
    bar: bool,
    tab: Tab,
    top: Top,
    favorite: bool,
    dark: Option<bool>,
    view: Option<String>,
    behind: Option<String>,
    #[serde(default)]
    ai: bool,
    labels: Labels,
}

fn view_key(key: &str) -> bool {
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.');

    !key.is_empty() && key.len() <= MAX_VIEW_KEY && key.chars().all(allowed)
}

impl Chrome {
    fn known_views(&self) -> bool {
        [&self.view, &self.behind]
            .into_iter()
            .flatten()
            .all(|key| view_key(key))
    }

    fn plain(&self) -> bool {
        let fits = |label: &&String| {
            label.chars().count() <= MAX_LABEL && !label.chars().any(char::is_control)
        };

        self.labels.all().iter().all(fits)
    }
}

#[cfg(target_os = "ios")]
mod native {
    use std::{
        ffi::{CStr, CString, c_char},
        sync::OnceLock,
    };

    use tauri::{AppHandle, Emitter};

    const ACTIONS: [&str; 9] = [
        "home", "pages", "search", "ai", "add", "back", "favorite", "more", "settings",
    ];
    static APP: OnceLock<AppHandle> = OnceLock::new();

    unsafe extern "C" {
        fn kladde_chrome_update(state: *const c_char, notice: extern "C" fn(*const c_char));

        fn kladde_chrome_remember(key: *const c_char);
    }

    extern "C" fn notice(action: *const c_char) {
        if action.is_null() {
            return;
        }

        let Ok(action) = unsafe { CStr::from_ptr(action) }.to_str() else {
            return;
        };

        if let Some(app) = APP.get()
            && ACTIONS.contains(&action)
        {
            let _ = app.emit("chrome", action);
        }
    }

    pub fn show(app: AppHandle, state: &super::Chrome) -> bool {
        let Ok(json) = serde_json::to_string(state) else {
            return false;
        };

        let Ok(text) = CString::new(json) else {
            return false;
        };

        let _ = APP.set(app);

        unsafe { kladde_chrome_update(text.as_ptr(), notice) };

        true
    }

    pub fn remember(key: &str) -> bool {
        let Ok(text) = CString::new(key) else {
            return false;
        };

        unsafe { kladde_chrome_remember(text.as_ptr()) };

        true
    }
}

#[tauri::command]
pub fn chrome(app: AppHandle, state: Chrome) -> bool {
    if !state.plain() || !state.known_views() {
        return false;
    }

    #[cfg(target_os = "ios")]
    {
        native::show(app, &state)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;

        false
    }
}

#[tauri::command]
pub fn remember_screen(key: String) -> bool {
    if !view_key(&key) {
        return false;
    }

    #[cfg(target_os = "ios")]
    {
        native::remember(&key)
    }

    #[cfg(not(target_os = "ios"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{Chrome, view_key};

    fn state(label: &str) -> Chrome {
        let json = serde_json::json!({
            "bar": true, "tab": "home", "top": "page", "favorite": false, "dark": null,
            "labels": {
                "home": label, "pages": "Seiten", "search": "Suche", "ai": "KI", "add": "Neu",
                "back": "Zurück", "favorite": "Favorit", "more": "Mehr", "settings": "Einstellungen"
            }
        });

        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn labels_are_short_plain_text() {
        assert!(state("Start").plain());
        assert!(!state(&"x".repeat(41)).plain());
        assert!(!state("Start\n").plain());
    }

    #[test]
    fn unknown_tabs_and_fields_are_refused() {
        let unknown = serde_json::json!({"bar": true, "tab": "other", "top": "page"});

        assert!(serde_json::from_value::<Chrome>(unknown).is_err());
    }

    #[test]
    fn view_keys_are_short_identifiers() {
        assert!(view_key("root:home"));
        assert!(view_key("0b5c8f2e-91d4-4c1a-9f3e-6a7b8c9d0e1f"));
        assert!(!view_key(""));
        assert!(!view_key("root:home/../x"));
        assert!(!view_key("seite mit leerzeichen"));
        assert!(!view_key(&"a".repeat(81)));
    }

    #[test]
    fn chrome_refuses_unknown_view_keys() {
        let mut shown = state("Start");

        shown.view = Some("root:home".into());
        shown.behind = Some("<script>".into());
        assert!(!shown.known_views());
        shown.behind = None;
        assert!(shown.known_views());
    }
}
