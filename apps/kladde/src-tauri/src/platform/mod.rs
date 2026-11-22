pub mod app_lifecycle;
pub mod haptic;
pub mod ios_navigation_bars;
pub mod keychain;

#[cfg(target_os = "macos")]
pub mod navigation_gestures;
pub mod web_links;

#[tauri::command]
pub fn platform() -> &'static str {
    std::env::consts::OS
}
