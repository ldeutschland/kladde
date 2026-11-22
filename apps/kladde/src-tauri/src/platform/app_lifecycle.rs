use std::sync::OnceLock;
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();

type Signal = extern "C" fn();

unsafe extern "C" {
    fn kladde_watch_network(changed: Signal) -> bool;
}

#[cfg(target_os = "ios")]
unsafe extern "C" {
    fn kladde_background_hold(id: u64);

    fn kladde_background_release(id: u64);

    fn kladde_watch_lifecycle(leaving: Signal, returning: Signal) -> bool;
}

#[cfg(target_os = "ios")]
const LEAVING_HOLD: u64 = 0;

#[cfg(target_os = "ios")]
static NEXT_HOLD: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub fn start(app: AppHandle) {
    let _ = APP.set(app);

    if !unsafe { kladde_watch_network(network_changed) } {
        eprintln!("Network monitor unavailable");
    }

    #[cfg(target_os = "ios")]
    if !unsafe { kladde_watch_lifecycle(leaving, returning) } {
        eprintln!("Lifecycle monitor unavailable");
    }
}

extern "C" fn network_changed() {
    if let Some(app) = APP.get() {
        crate::attachments::uploads::resume(app);
        crate::sync::live_watch::wake(app);
    }
}

#[cfg(target_os = "ios")]
extern "C" fn leaving() {
    let hold = Hold::adopted();
    let Some(app) = APP.get().cloned() else {
        return;
    };

    tauri::async_runtime::spawn(async move {
        let _hold = hold;

        crate::sync::document_sync::sync_on_leave(&app).await;
    });
}

#[cfg(target_os = "ios")]
extern "C" fn returning() {
    if let Some(app) = APP.get() {
        crate::attachments::uploads::resume(app);
        crate::sync::live_watch::wake(app);
    }
}

#[cfg(not(target_os = "ios"))]
pub struct Hold;

#[cfg(not(target_os = "ios"))]
impl Hold {
    pub fn new() -> Self {
        Self
    }
}

#[cfg(target_os = "ios")]
pub struct Hold(u64);

#[cfg(target_os = "ios")]
impl Hold {
    pub fn new() -> Self {
        let id = NEXT_HOLD.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        unsafe { kladde_background_hold(id) };

        Self(id)
    }

    fn adopted() -> Self {
        Self(LEAVING_HOLD)
    }
}

#[cfg(target_os = "ios")]
impl Drop for Hold {
    fn drop(&mut self) {
        unsafe { kladde_background_release(self.0) };
    }
}
