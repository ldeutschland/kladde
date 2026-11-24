#[cfg(feature = "native-acceptance")]
#[path = "../../../../tests/native/harness.rs"]
mod acceptance;

#[cfg(all(feature = "native-acceptance", feature = "distribution"))]
compile_error!("Acceptance builds cannot be distributed");
mod ai;
mod attachments;
mod capture;
mod notebook;
mod platform;
mod sync;
use notebook::vault::Vault;
use std::sync::Mutex;

pub fn start() {
    #[cfg(feature = "browser-extension")]
    if let Some(caller) = capture::browser_extension_host::requested() {
        std::process::exit(capture::browser_extension_host::serve(&caller));
    }

    run()
}

const DEV_SERVER_PORT: u16 = 1420;

fn is_app_address(url: &tauri::Url) -> bool {
    let bundled = url.scheme() == "tauri" && url.host_str() == Some("localhost");
    let dev_server = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(DEV_SERVER_PORT);

    bundled || dev_server
}

fn local_navigation_only() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<_, ()>::new("local-navigation")
        .on_navigation(|_, url| is_app_address(url))
        .build()
}

fn with_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let builder = builder.plugin(local_navigation_only());

    #[cfg(feature = "native-acceptance")]
    let builder = builder.plugin(acceptance::plugin());

    builder
}

fn with_shared_state(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(sync::SyncState::default())
        .manage(sync::live_watch::Watching::default())
        .manage(attachments::uploads::Uploads::default())
        .manage(capture::audio_notes::Recorder::default())
        .manage(notebook::backup::Restores::default())
        .manage(ai::Runs::default())
        .manage(Vault(Mutex::new(None)))
}

fn start_background_work(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    capture::quick_capture_shortcut::register(app.handle().clone());

    #[cfg(target_os = "macos")]
    platform::navigation_gestures::register(app.handle().clone());

    #[cfg(all(target_os = "macos", feature = "browser-extension"))]
    capture::browser_extension_setup::refresh();
    tauri::async_runtime::spawn(attachments::search_index::index_files(app.handle().clone()));
    platform::app_lifecycle::start(app.handle().clone());
    capture::audio_notes::start(app.handle().clone());

    #[cfg(target_os = "ios")]
    attachments::downloads_folder::discard_shared(app.handle());
    sync::live_watch::start(app.handle().clone());

    Ok(())
}

fn commands() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        platform::platform,
        capture::share_extension_inbox::shared_items,
        capture::share_extension_inbox::shared_item,
        capture::share_extension_inbox::finish_shared_item,
        platform::haptic::haptic,
        platform::ios_navigation_bars::chrome,
        platform::ios_navigation_bars::remember_screen,
        notebook::pages::spaces,
        notebook::pages::opened_space,
        notebook::pages::remember_space,
        notebook::pages::load,
        notebook::pages::load_manifest,
        notebook::pages::load_state,
        notebook::pages::save,
        notebook::pages::search,
        attachments::search_index::search_content,
        attachments::attachment_text::list_attachments,
        attachments::attachment_text::read_attachment,
        attachments::previews::preview_attachment,
        attachments::previews::find_in_attachment,
        attachments::previews::attachment_thumbnail,
        attachments::pdf_editing::pdf_pages,
        attachments::pdf_editing::edit_pdf,
        platform::web_links::open_web_source,
        notebook::database_rows::rows,
        notebook::database_rows::rows_changed,
        notebook::pages::backlinks,
        notebook::versions::versions,
        notebook::versions::version,
        notebook::versions::keep_version,
        notebook::versions::label_version,
        notebook::versions::delete_version,
        sync::shared_versions::share_versions,
        sync::shared_versions::shared_version,
        sync::shared_versions::drop_shared_version,
        notebook::pages::forget,
        ai::ai_policy,
        ai::ai_settings,
        ai::ai_key,
        ai::ai_models,
        ai::ai_start,
        ai::ai_stop,
        ai::ai_turn,
        sync::account_setup::connect_account,
        sync::account_setup::phrase,
        sync::document_sync::sync_now,
        sync::workspaces::remote_spaces,
        sync::devices::account_info,
        sync::devices::device_action,
        sync::document_sync::discard_rescued,
        sync::document_sync::repair_sync,
        sync::live_watch::sync_watch,
        notebook::backup::export_backup,
        attachments::encrypted_files::add_file,
        attachments::file_reading::read_file,
        attachments::downloads_folder::save_download,
        attachments::downloads_folder::export_file,
        capture::audio_notes::audio_start,
        capture::audio_notes::audio_pause,
        capture::audio_notes::audio_resume,
        capture::audio_notes::audio_stop,
        capture::audio_notes::audio_discard,
        capture::audio_notes::audio_save,
        capture::audio_notes::audio_transcribe,
        capture::audio_notes::audio_languages,
        capture::web_clips::clip_page,
        capture::web_clips::clip_image,
        capture::web_clips::clip_inbox,
        capture::web_clips::clip_inbox_item,
        capture::web_clips::clip_inbox_preview,
        capture::web_clips::finish_clip_inbox_item,
        capture::browser_extension_setup::clipper_status,
        capture::browser_extension_setup::clipper_setup,
        capture::browser_extension_setup::clipper_remove,
        capture::browser_extension_setup::clipper_reveal,
        notebook::backup::import_backup,
        notebook::backup::import_backup_start,
        notebook::backup::import_backup_part,
        notebook::backup::import_backup_abort
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    with_shared_state(with_plugins(tauri::Builder::default()))
        .setup(start_background_work)
        .invoke_handler(commands())
        .run(tauri::generate_context!())
        .expect("Kladde could not start");
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
        let from = text.find(start).expect(start) + start.len();
        let to = from + text[from..].find(end).expect(end);
        &text[from..to]
    }

    fn handlers() -> BTreeSet<String> {
        between(include_str!("lib.rs"), "generate_handler![", "]")
            .split(',')
            .filter_map(|path| path.trim().rsplit("::").next())
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn manifest_commands() -> BTreeSet<String> {
        between(include_str!("../build.rs"), "let commands = &[", "];")
            .split(',')
            .map(|name| name.trim().trim_matches('"').to_string())
            .filter(|name| !name.is_empty())
            .collect()
    }

    fn allowed_commands() -> BTreeSet<String> {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|permission| permission.as_str()?.strip_prefix("allow-"))
            .map(|name| name.replace('-', "_"))
            .collect()
    }

    #[test]
    fn every_command_is_registered_and_allowed() {
        let handlers = handlers();

        assert_eq!(manifest_commands(), handlers);
        assert_eq!(allowed_commands(), handlers);
    }
}
