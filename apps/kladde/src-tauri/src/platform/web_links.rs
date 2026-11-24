use std::ffi::{CString, c_char};

unsafe extern "C" {
    fn kladde_open_source(address: *const c_char);
}

const MAX_ADDRESS_LENGTH: usize = 2048;
const INVALID_ADDRESS: &str = "Invalid source URL";

fn is_web_page(url: &url::Url) -> bool {
    matches!(url.scheme(), "https" | "http")
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn is_mail_address(url: &url::Url) -> bool {
    url.scheme() == "mailto" && url.path().contains('@')
}

#[tauri::command]
pub fn open_web_source(address: String) -> Result<(), String> {
    if address.len() > MAX_ADDRESS_LENGTH || address.chars().any(char::is_control) {
        return Err(INVALID_ADDRESS.into());
    }

    let url = url::Url::parse(&address).map_err(|_| INVALID_ADDRESS)?;

    if !is_web_page(&url) && !is_mail_address(&url) {
        return Err(INVALID_ADDRESS.into());
    }

    let address = CString::new(url.as_str()).map_err(|_| INVALID_ADDRESS)?;

    unsafe { kladde_open_source(address.as_ptr()) };

    Ok(())
}
