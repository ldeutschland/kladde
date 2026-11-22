use crate::platform::keychain::{read_secret, write_secret};
use kladde_store::Store;
use rand::{RngCore, rngs::OsRng};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};

use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

pub struct Vault(pub Mutex<Option<Store>>);

fn database(path: &Path, service: &str) -> Result<Store, String> {
    let key = match read_secret(service, "local-db-v1")? {
        Some(bytes) => {
            Zeroizing::new(<[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| "Keychain data")?)
        }
        None if !path.exists() => {
            let mut key = Zeroizing::new([0u8; 32]);

            OsRng.fill_bytes(key.as_mut());
            write_secret(service, "local-db-v1", key.as_ref())?;

            key
        }
        None => return Err("Missing database key".into()),
    };

    Store::open(path, &key).map_err(|e| e.to_string())
}

impl Vault {
    pub fn lock<'a>(&'a self, app: &AppHandle) -> Result<MutexGuard<'a, Option<Store>>, String> {
        let mut guard = self.0.lock().map_err(|_| "Storage unavailable")?;

        if guard.is_none() {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|_| "Storage unavailable")?;
            #[cfg(feature = "native-acceptance")]
            let dir = dir
                .join("acceptance")
                .join(crate::acceptance::run_id().to_string());
            std::fs::create_dir_all(&dir).map_err(|_| "Storage unavailable")?;
            let service = &app.config().identifier;

            #[cfg(feature = "native-acceptance")]
            let service = format!("{service}.acceptance.{}", crate::acceptance::run_id());
            *guard = Some(database(&dir.join("notebook.db"), service.as_str())?);
        }

        Ok(guard)
    }

    pub fn access<T>(
        &self,
        app: &AppHandle,
        work: impl FnOnce(&mut Store) -> Result<T, kladde_store::Error>,
    ) -> Result<T, String> {
        let mut guard = self.lock(app)?;

        work(guard.as_mut().ok_or("Storage unavailable")?).map_err(|e| e.to_string())
    }
}
