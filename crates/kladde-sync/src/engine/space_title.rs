use super::doc_exchange::{collect_items, subscribe};
use super::doc_state_keys::DocKeys;
use crate::{Cursor, Error, Socket, account::Access};
use kladde_store::Incoming;

pub async fn space_title(socket: &mut Socket, access: &Access) -> Result<Option<String>, Error> {
    let keys = DocKeys::new(access, access.space);
    let mut cursor = Cursor::default();
    let mut incoming = Incoming::default();
    let mut damaged = false;

    subscribe(socket, access, &keys, &cursor).await?;
    collect_items(
        socket,
        access,
        &keys,
        &mut cursor,
        &mut incoming,
        &mut damaged,
    )
    .await?;

    Ok(incoming.workspace_title())
}
