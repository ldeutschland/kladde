use super::access::{Ring, keyset};
use crate::Error;
use ed25519_dalek::SigningKey;
use kladde_crypto::{self as c, Purpose};
use kladde_protocol::{account::*, decode};
use zeroize::Zeroizing;

pub(super) fn opaque_error<T>(_: T) -> Error {
    Error::Auth
}

pub(super) fn check_user(user: &str, password: &str) -> Result<(), Error> {
    if !(3..=64).contains(&user.len())
        || !user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || !(12..=1024).contains(&password.len())
    {
        return Err(Error::Auth);
    }

    Ok(())
}

pub(super) fn check_bundle(bundle: &AccountBundle) -> Result<(), Error> {
    if bundle.version != 1 || bundle.ksf != 1 {
        return Err(Error::Auth);
    }

    Ok(())
}

pub(super) fn open_ring(
    bundle: &AccountBundle,
    master: &[u8],
) -> Result<(SigningKey, Zeroizing<Vec<u8>>), Error> {
    check_bundle(bundle)?;
    let ring: Ring = decode(&bundle.keys)?;
    let identity = SigningKey::from_bytes(
        c::unwrap(master, bundle.account, Purpose::Identity, &ring.identity)?
            .as_slice()
            .try_into()
            .map_err(opaque_error)?,
    );

    if identity.verifying_key().to_bytes() != bundle.identity {
        return Err(Error::Auth);
    }

    let workspace = c::unwrap(master, bundle.space, Purpose::Workspace, &ring.workspace)?;

    Ok((identity, keyset(&workspace, &bundle.identity)?))
}
