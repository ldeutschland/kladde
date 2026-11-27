use std::{path::Path, process::Command};

const SHARED_SWIFT: &str = "src/native/audio_notes.swift";
const PHONE_SWIFT: &str = "src/native/ios_navigation_bars.swift";
const DOCUMENT_SOURCES: [&str; 3] = [
    "src/native/text_and_previews.m",
    "src/native/pdf_editing.m",
    "src/native/pdf_editing.h",
];
const LIFECYCLE_SOURCE: &str = "src/native/app_lifecycle.m";
const BACKUP_SOURCE: &str = "src/native/backup_exclusion.m";
const MACOS_SOURCES: [&str; 4] = [
    "src/native/quick_capture_shortcut.m",
    "src/native/navigation_gestures.m",
    "src/native/download_quarantine.m",
    "src/native/reveal_in_finder.m",
];
const DEPLOYMENT: &str = "26.0";

struct Apple {
    triple: String,
    sdk: &'static str,
    runtime: &'static str,
}

fn apple(target: &str) -> Option<Apple> {
    let macos = std::env::var("MACOSX_DEPLOYMENT_TARGET").unwrap_or_else(|_| DEPLOYMENT.into());
    let ios = std::env::var("IPHONEOS_DEPLOYMENT_TARGET").unwrap_or_else(|_| DEPLOYMENT.into());
    let (triple, sdk, runtime) = match target {
        "aarch64-apple-darwin" => (format!("arm64-apple-macos{macos}"), "macosx", "macosx"),
        "x86_64-apple-darwin" => (format!("x86_64-apple-macos{macos}"), "macosx", "macosx"),
        "aarch64-apple-ios" => (format!("arm64-apple-ios{ios}"), "iphoneos", "iphoneos"),
        "aarch64-apple-ios-sim" => (
            format!("arm64-apple-ios{ios}-simulator"),
            "iphonesimulator",
            "iphonesimulator",
        ),
        "x86_64-apple-ios" => (
            format!("x86_64-apple-ios{ios}-simulator"),
            "iphonesimulator",
            "iphonesimulator",
        ),
        _ => return None,
    };

    Some(Apple {
        triple,
        sdk,
        runtime,
    })
}

fn tool_output(sdk: &str, arguments: &[&str]) -> String {
    let output = Command::new("xcrun")
        .args(["--sdk", sdk])
        .args(arguments)
        .env_remove("SDKROOT")
        .output()
        .expect("xcrun");
    assert!(output.status.success(), "xcrun {arguments:?} failed");
    String::from_utf8(output.stdout)
        .expect("xcrun output")
        .trim()
        .to_owned()
}

fn run_tool(sdk: &str, arguments: &[&str]) {
    let status = Command::new("xcrun")
        .args(["--sdk", sdk])
        .args(arguments)
        .env_remove("SDKROOT")
        .status()
        .expect("xcrun");
    assert!(status.success(), "xcrun {arguments:?} failed");
}

fn compile_swift(target: &str) {
    let platform = apple(target).expect("Apple target");
    let out = std::env::var("OUT_DIR").expect("OUT_DIR");
    let object = format!("{out}/native.o");
    let library = format!("{out}/libkladde_native.a");
    let mut sources = vec![SHARED_SWIFT];

    if platform.sdk != "macosx" {
        sources.push(PHONE_SWIFT);
    }

    let sdk = tool_output(platform.sdk, &["--show-sdk-path"]);
    let swiftc = tool_output(platform.sdk, &["--find", "swiftc"]);
    let mut compile = vec![
        "swiftc",
        "-swift-version",
        "5",
        "-parse-as-library",
        "-whole-module-optimization",
        "-O",
        "-target",
        &platform.triple,
        "-sdk",
        &sdk,
        "-module-name",
        "KladdeNative",
        "-emit-object",
        "-o",
        &object,
    ];

    compile.extend(&sources);
    run_tool(platform.sdk, &compile);
    let _ = std::fs::remove_file(&library);

    run_tool(platform.sdk, &["ar", "rcs", &library, &object]);
    let toolchain = Path::new(&swiftc)
        .ancestors()
        .nth(2)
        .expect("Swift toolchain")
        .join("lib/swift")
        .join(platform.runtime);
    for source in sources {
        println!("cargo:rerun-if-changed={source}");
    }

    println!("cargo:rustc-link-search=native={out}");
    println!("cargo:rustc-link-lib=static=kladde_native");
    println!("cargo:rustc-link-search=native={sdk}/usr/lib/swift");
    println!("cargo:rustc-link-search=native={}", toolchain.display());

    for framework in ["AVFoundation", "AVFAudio", "Speech", "CoreMedia"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }

    if platform.sdk == "macosx" {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}

fn compile_objective_c(sources: &[&str], library: &str) {
    let mut build = cc::Build::new();

    for source in sources.iter().filter(|source| source.ends_with(".m")) {
        build.file(source);
    }

    build.flag("-fobjc-arc").compile(library);

    for source in sources {
        println!("cargo:rerun-if-changed={source}");
    }
}

fn link_frameworks(frameworks: &[&str]) {
    for framework in frameworks {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}

fn compile_native() {
    compile_swift(&std::env::var("TARGET").expect("TARGET"));
    compile_objective_c(&DOCUMENT_SOURCES, "kladde_documents");
    link_frameworks(&["Foundation", "PDFKit", "Vision", "ImageIO", "CoreGraphics"]);
    let target = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    if target == "macos" || target == "ios" {
        compile_objective_c(&[LIFECYCLE_SOURCE], "kladde_lifecycle");
        compile_objective_c(&[BACKUP_SOURCE], "kladde_backup");
        link_frameworks(&["Network"]);
    }

    if target == "ios" {
        link_frameworks(&["UIKit"]);
    }

    if target == "macos" {
        compile_objective_c(&MACOS_SOURCES, "kladde_macos");
        link_frameworks(&["AppKit", "Carbon", "CoreServices"]);
    }
}

fn build_tauri() {
    let commands = &[
        "platform",
        "shared_items",
        "shared_item",
        "finish_shared_item",
        "haptic",
        "chrome",
        "remember_screen",
        "spaces",
        "opened_space",
        "remember_space",
        "load",
        "load_manifest",
        "load_state",
        "save",
        "search",
        "search_content",
        "list_attachments",
        "read_attachment",
        "preview_attachment",
        "find_in_attachment",
        "find_all_in_attachment",
        "attachment_thumbnail",
        "pdf_pages",
        "edit_pdf",
        "open_web_source",
        "rows",
        "rows_changed",
        "backlinks",
        "versions",
        "version",
        "keep_version",
        "label_version",
        "delete_version",
        "share_versions",
        "shared_version",
        "drop_shared_version",
        "forget",
        "ai_policy",
        "ai_settings",
        "ai_key",
        "ai_models",
        "ai_start",
        "ai_stop",
        "ai_turn",
        "local_ai_status",
        "local_ai_start",
        "local_ai_run",
        "local_ai_tool_result",
        "local_ai_stop",
        "local_models",
        "local_model_download",
        "local_model_cancel",
        "local_model_delete",
        "connect_account",
        "phrase",
        "sync_now",
        "sync_others",
        "remote_spaces",
        "sync_choices",
        "exclude_space",
        "remove_space",
        "delete_space",
        "account_info",
        "device_action",
        "discard_rescued",
        "repair_sync",
        "sync_watch",
        "export_backup",
        "add_file",
        "read_file",
        "save_download",
        "export_file",
        "audio_start",
        "audio_pause",
        "audio_resume",
        "audio_stop",
        "audio_discard",
        "audio_save",
        "audio_transcribe",
        "audio_languages",
        "clip_page",
        "clip_image",
        "clip_inbox",
        "clip_inbox_item",
        "clip_inbox_preview",
        "finish_clip_inbox_item",
        "clipper_status",
        "clipper_setup",
        "clipper_remove",
        "clipper_reveal",
        "import_backup",
        "import_backup_start",
        "import_backup_part",
        "import_backup_abort",
    ];
    let manifest = tauri_build::AppManifest::new().commands(commands);

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("Tauri permissions");
}

fn main() {
    compile_native();
    build_tauri();
}
