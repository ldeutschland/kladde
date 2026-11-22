const UNAVAILABLE: &str = "Browser extension unavailable in this build";

#[tauri::command]
pub fn clipper_status() -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub fn clipper_setup() -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub fn clipper_remove() -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub fn clipper_reveal() -> Result<(), String> {
    Err(UNAVAILABLE.into())
}
