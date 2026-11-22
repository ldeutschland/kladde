use std::ffi::{CString, c_char};

unsafe extern "C" {
    fn kladde_open_source(address: *const c_char);
}

#[tauri::command]
pub fn open_web_source(address: String) -> Result<(), String> {
    if address.len() > 2048 || address.chars().any(char::is_control) {
        return Err("Invalid source URL".into());
    }

    let url = url::Url::parse(&address).map_err(|_| "Invalid source URL")?;

    if !matches!(url.scheme(), "https" | "http")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Invalid source URL".into());
    }

    let address = CString::new(url.as_str()).map_err(|_| "Invalid source URL")?;

    unsafe { kladde_open_source(address.as_ptr()) };

    Ok(())
}
