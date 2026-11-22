use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use tauri::ipc::Response;
use zeroize::Zeroizing;

#[derive(Deserialize)]
#[serde(untagged)]
pub enum FileInput {
    Base64(String),
    Bytes(Vec<u8>),
}

impl FileInput {
    pub fn bytes(self, limit: usize) -> Result<Zeroizing<Vec<u8>>, String> {
        let too_large = || format!("File exceeds {} MiB", limit / (1024 * 1024));
        let bytes = match self {
            Self::Bytes(data) => Zeroizing::new(data),
            Self::Base64(text) => {
                let text = Zeroizing::new(text);

                if text.len() > limit.div_ceil(3) * 4 {
                    return Err(too_large());
                }

                Zeroizing::new(
                    STANDARD
                        .decode(text.as_bytes())
                        .map_err(|_| "Invalid file encoding")?,
                )
            }
        };

        if bytes.len() > limit {
            return Err(too_large());
        }

        Ok(bytes)
    }
}

pub fn file_response(bytes: Vec<u8>, binary: Option<bool>) -> Result<Response, String> {
    if binary == Some(true) {
        return Ok(Response::new(bytes));
    }

    let json = serde_json::to_string(&*Zeroizing::new(bytes)).map_err(|_| "Invalid file")?;

    Ok(Response::new(json))
}
