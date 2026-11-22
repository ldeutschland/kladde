#[cfg(target_os = "ios")]
unsafe extern "C" {
    fn kladde_haptic();
}

#[tauri::command]
pub fn haptic() {
    #[cfg(target_os = "ios")]
    unsafe {
        kladde_haptic()
    }
}
