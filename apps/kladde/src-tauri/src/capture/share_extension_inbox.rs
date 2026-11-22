#[cfg(target_os = "ios")]
unsafe extern "C" {
    fn kladde_share_read(
        folder: i32,
        id: *const std::ffi::c_char,
        output: *mut std::ffi::c_void,
        copy: extern "C" fn(*mut std::ffi::c_void, *const u8, usize),
    ) -> bool;

    fn kladde_share_remove(folder: i32, id: *const std::ffi::c_char) -> bool;
}

#[cfg(target_os = "ios")]
#[derive(Clone, Copy)]
pub enum Folder {
    Inbox = 0,
    Clips = 1,
}

#[cfg(target_os = "ios")]
pub fn read(folder: Folder, id: Option<uuid::Uuid>) -> Result<Vec<u8>, String> {
    extern "C" fn copy(output: *mut std::ffi::c_void, bytes: *const u8, length: usize) {
        if !output.is_null() && !bytes.is_null() && length <= 65 * 1024 * 1024 {
            unsafe {
                (*output.cast::<Vec<u8>>())
                    .extend_from_slice(std::slice::from_raw_parts(bytes, length));
            }
        }
    }

    let id = std::ffi::CString::new(id.map(|v| v.to_string()).unwrap_or_default())
        .map_err(|_| "Invalid ID")?;
    let mut data = Vec::new();

    if !unsafe { kladde_share_read(folder as i32, id.as_ptr(), (&raw mut data).cast(), copy) } {
        return Err("Shared inbox unavailable".into());
    }

    Ok(data)
}

#[cfg(target_os = "ios")]
pub fn list(folder: Folder) -> Result<Vec<uuid::Uuid>, String> {
    serde_json::from_slice(&read(folder, None)?).map_err(|_| "Invalid inbox".into())
}

#[cfg(target_os = "ios")]
pub fn remove(folder: Folder, id: uuid::Uuid) -> Result<(), String> {
    let key = std::ffi::CString::new(id.to_string()).map_err(|_| "Invalid ID")?;

    if unsafe { kladde_share_remove(folder as i32, key.as_ptr()) } {
        return Ok(());
    }

    Err("Inbox unavailable".into())
}

#[tauri::command]
pub fn shared_items() -> Result<Vec<uuid::Uuid>, String> {
    #[cfg(target_os = "ios")]
    {
        list(Folder::Inbox)
    }

    #[cfg(not(target_os = "ios"))]
    Ok(Vec::new())
}

#[tauri::command]
pub async fn shared_item(id: uuid::Uuid) -> Result<tauri::ipc::Response, String> {
    #[cfg(target_os = "ios")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            read(Folder::Inbox, Some(id)).map(tauri::ipc::Response::new)
        })
        .await
        .map_err(|_| "Inbox unavailable")?
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = id;

        Err("Inbox unavailable".into())
    }
}

#[tauri::command]
pub fn finish_shared_item(id: uuid::Uuid) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        remove(Folder::Inbox, id)
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = id;

        Err("Inbox unavailable".into())
    }
}
