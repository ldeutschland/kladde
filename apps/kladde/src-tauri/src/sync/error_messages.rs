use kladde_sync::engine;

pub fn to_message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub fn account_error(error: kladde_sync::Error) -> String {
    match error {
        kladde_sync::Error::Outdated(_) => sync_error(&error),
        other => other.to_string(),
    }
}

pub fn success_or_message(
    response: reqwest::Response,
    refused: &str,
) -> Result<reqwest::Response, String> {
    engine::require_success(response).map_err(|e| match e {
        kladde_sync::Error::Outdated(_) => sync_error(&e),
        _ => refused.into(),
    })
}

pub fn sync_error(error: &kladde_sync::Error) -> String {
    format!("sync:{}", engine::error_code(error))
}
