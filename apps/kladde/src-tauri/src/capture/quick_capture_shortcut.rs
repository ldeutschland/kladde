use tauri::{AppHandle, Emitter, Manager};

static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

pub fn register(app: AppHandle) {
    unsafe extern "C" {
        fn kladde_register_capture(notify: extern "C" fn()) -> bool;
    }

    extern "C" fn notify() {
        if let Some(app) = APP.get()
            && let Some(window) = app.get_webview_window("main")
        {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            let _ = window.emit("quick-capture", ());
        }
    }

    let _ = APP.set(app);

    if !unsafe { kladde_register_capture(notify) } {
        eprintln!("Quick capture shortcut unavailable");
    }
}
