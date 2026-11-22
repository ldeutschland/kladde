use super::{access::Access, login::unlock};
use crate::{Error, Origin};
use kladde_protocol::account::*;
use reqwest::Client;

pub async fn erase(
    client: &Client,
    origin: &Origin,
    access: &Access,
    password: &str,
) -> Result<(), Error> {
    let (keys, _) = unlock(client, origin, &access.username, password).await?;

    if keys.bundle.account != access.account {
        return Err(Error::Auth);
    }

    let url = origin.0.join("v1/account").map_err(|_| Error::Url)?;
    let confirmed = Erase {
        ticket: keys.ticket,
    };

    let sent = client
        .delete(url)
        .bearer_auth(&access.token)
        .json(&confirmed)
        .send()
        .await
        .map_err(|_| Error::Network)?;
    crate::engine::require_success(sent).map(|_| ())
}
