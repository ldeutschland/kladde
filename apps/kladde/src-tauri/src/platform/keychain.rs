use security_framework::{
    passwords::{generic_password, set_generic_password_options},
    passwords_options::PasswordOptions,
};

use zeroize::Zeroizing;

fn options(service: &str, name: &str) -> PasswordOptions {
    let options = PasswordOptions::new_generic_password(service, name);

    #[cfg(any(target_os = "ios", feature = "distribution"))]
    {
        let mut options = options;

        options.use_protected_keychain();

        options
    }

    #[cfg(not(any(target_os = "ios", feature = "distribution")))]
    options
}

const ITEM_NOT_FOUND: i32 = -25300;

fn keychain_error(error: security_framework::base::Error) -> String {
    format!("Keychain ({})", error.code())
}

pub fn read_secret(service: &str, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    match generic_password(options(service, name)) {
        Ok(bytes) => Ok(Some(Zeroizing::new(bytes))),
        Err(e) if e.code() == ITEM_NOT_FOUND => move_legacy_secret(service, name),
        Err(e) => Err(keychain_error(e)),
    }
}

#[cfg(all(target_os = "macos", feature = "distribution"))]
fn move_legacy_secret(service: &str, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    use security_framework::passwords::delete_generic_password_options;

    let legacy = || PasswordOptions::new_generic_password(service, name);
    let bytes = match generic_password(legacy()) {
        Ok(bytes) => Zeroizing::new(bytes),
        Err(e) if e.code() == ITEM_NOT_FOUND => return Ok(None),
        Err(e) => return Err(keychain_error(e)),
    };

    write_secret(service, name, &bytes)?;
    delete_generic_password_options(legacy()).map_err(keychain_error)?;

    Ok(Some(bytes))
}

#[cfg(not(all(target_os = "macos", feature = "distribution")))]
fn move_legacy_secret(_: &str, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    Ok(None)
}

pub fn write_secret(service: &str, name: &str, bytes: &[u8]) -> Result<(), String> {
    let options = options(service, name);

    #[cfg(any(target_os = "ios", feature = "distribution"))]
    let options = {
        use security_framework::access_control::{ProtectionMode, SecAccessControl};

        let mut options = options;
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            0,
        )
        .map_err(|_| "Keychain access")?;

        options.set_access_control(access);

        options
    };

    set_generic_password_options(bytes, options).map_err(keychain_error)
}
