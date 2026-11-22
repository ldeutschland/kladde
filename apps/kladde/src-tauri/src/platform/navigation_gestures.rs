use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();

unsafe extern "C" {
    fn kladde_watch_navigation(notify: extern "C" fn(i32)) -> bool;
}

fn direction_name(direction: i32) -> Option<&'static str> {
    match direction {
        -1 => Some("back"),
        1 => Some("forward"),
        _ => None,
    }
}

extern "C" fn notify(direction: i32) {
    let Some(name) = direction_name(direction) else {
        return;
    };

    if let Some(app) = APP.get()
        && let Some(window) = app.get_webview_window("main")
        && window.is_focused().unwrap_or(false)
    {
        let _ = window.emit("navigate", name);
    }
}

pub fn register(app: AppHandle) {
    let _ = APP.set(app);

    if !unsafe { kladde_watch_navigation(notify) } {
        eprintln!("Navigation gestures unavailable");
    }
}

#[cfg(test)]
mod tests {
    use super::direction_name;

    #[test]
    fn only_known_directions_are_named() {
        assert_eq!(direction_name(-1), Some("back"));
        assert_eq!(direction_name(1), Some("forward"));
        assert_eq!(direction_name(0), None);
        assert_eq!(direction_name(7), None);
    }
}
