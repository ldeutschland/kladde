pub mod audio_notes;
#[cfg(feature = "browser-extension")]
pub mod browser_extension_host;

#[cfg(feature = "browser-extension")]
pub mod browser_extension_setup;

#[cfg(not(feature = "browser-extension"))]
#[path = "browser_extension_unavailable.rs"]
pub mod browser_extension_setup;
#[cfg_attr(not(feature = "browser-extension"), allow(dead_code))]
pub mod clip_inbox;

#[cfg(target_os = "macos")]
pub mod quick_capture_shortcut;
pub mod share_extension_inbox;
pub mod web_clips;
