use crate::Invalid;
use argon2::{Algorithm, Argon2, Params, Version};
pub use opaque_ke::{
    ClientLogin, ClientLoginFinishParameters, ClientRegistration,
    ClientRegistrationFinishParameters, CredentialFinalization, CredentialRequest,
    CredentialResponse, RegistrationRequest, RegistrationResponse, RegistrationUpload, ServerLogin,
    ServerLoginParameters, ServerRegistration, ServerSetup,
};

pub const CONTEXT: &[u8] = b"kladde/v1/opaque";

pub struct Suite;

impl opaque_ke::CipherSuite for Suite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, sha2::Sha512>;
    type Ksf = Argon2<'static>;
}

pub fn ksf() -> Result<Argon2<'static>, Invalid> {
    Ok(Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(65536, 3, 1, None).map_err(|_| Invalid)?,
    ))
}
