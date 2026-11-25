use super::Local;
use super::relay_requests::{proof, require_success, signed_call};
use crate::{Error, Origin, account::Access};
use kladde_protocol::account::{PROOF_HEADER, discard_message, erase_blob_message, purge_message};
use kladde_store::Store;
use reqwest::Method;
use std::collections::BTreeSet;
use uuid::Uuid;

#[derive(Clone, Copy)]
enum Erased {
    Docs,
    Blobs,
}

impl Erased {
    fn path(self, access: &Access, id: Uuid) -> String {
        let kind = match self {
            Erased::Docs => "docs",
            Erased::Blobs => "blobs",
        };

        format!("v1/spaces/{}/{kind}/{id}", access.space)
    }

    fn message(self, access: &Access, id: Uuid) -> Result<Vec<u8>, Error> {
        Ok(match self {
            Erased::Docs => purge_message(access.account, access.space, id)?,
            Erased::Blobs => erase_blob_message(access.account, access.space, id)?,
        })
    }
}

async fn erase(
    client: &reqwest::Client,
    access: &Access,
    erased: Erased,
    id: Uuid,
) -> Result<(), Error> {
    let path = erased.path(access, id);
    let message = erased.message(access, id)?;

    signed_call(client, access, Method::DELETE, &path, &message).await?;

    Ok(())
}

pub async fn erase_blob(client: &reqwest::Client, access: &Access, id: Uuid) -> Result<(), Error> {
    erase(client, access, Erased::Blobs, id).await
}

async fn purge_all(
    client: &reqwest::Client,
    access: &Access,
    ids: Vec<Uuid>,
    erased: Erased,
    done: impl Fn(&mut Store, Uuid) -> Result<(), kladde_store::Error>,
    local: &impl Local,
) -> Result<Vec<Uuid>, Error> {
    let mut refused = Vec::new();

    for id in ids {
        match erase(client, access, erased, id).await {
            Ok(()) => local.with(|store| done(store, id))?,
            Err(Error::Denied) => refused.push(id),
            Err(e) => return Err(e),
        }
    }

    Ok(refused)
}

async fn discard_rows(
    local: &impl Local,
    client: &reqwest::Client,
    access: &Access,
) -> Result<Vec<Uuid>, Error> {
    let path = format!("v1/spaces/{}/discard", access.space);
    let url = Origin::parse(&access.origin)?
        .0
        .join(&path)
        .map_err(|_| Error::Url)?;
    loop {
        let Some((owner, ids)) = local.with(|store| store.discards(access.space))? else {
            return Ok(Vec::new());
        };

        let body = serde_json::json!({ "owner": owner, "ids": ids });
        let message = discard_message(access.account, access.space, owner, &ids)?;
        let sent = client
            .post(url.clone())
            .bearer_auth(&access.token)
            .header(PROOF_HEADER, proof(access, &message))
            .json(&body);
        let reply = sent.send().await.map_err(|_| Error::Network)?;

        match require_success(reply) {
            Ok(_) => local.with(|store| store.discarded(&ids))?,
            Err(Error::Denied) => return purge_singly(local, client, access, ids).await,
            Err(e) => return Err(e),
        }
    }
}

async fn purge_singly(
    local: &impl Local,
    client: &reqwest::Client,
    access: &Access,
    ids: Vec<Uuid>,
) -> Result<Vec<Uuid>, Error> {
    let done = |store: &mut Store, id: Uuid| store.discarded(&[id]);

    purge_all(client, access, ids, Erased::Docs, done, local).await
}

fn locate_texts(local: &impl Local, access: &Access) -> Result<(), Error> {
    let texts = local.with(|store| store.erased_texts(access.space))?;

    if texts.is_empty() {
        return Ok(());
    }

    let blobs = texts
        .into_iter()
        .map(|(doc, file)| Ok((doc, file, access.text_id(doc, file)?)))
        .collect::<Result<Vec<_>, Error>>()?;

    local.with(|store| store.erase_text_blobs(access.space, &blobs))
}

fn publishable_deletions(local: &impl Local, space: Uuid) -> Result<Vec<Uuid>, Error> {
    if local.with(|store| store.listing_waits(space))? {
        return Ok(Vec::new());
    }

    let pending = local.with(|store| store.deletions(space))?;

    Ok(listed_among(local, space, pending)?.1)
}

pub(super) fn listed_among(
    local: &impl Local,
    space: Uuid,
    ids: impl IntoIterator<Item = Uuid>,
) -> Result<(BTreeSet<Uuid>, Vec<Uuid>), Error> {
    let mut listed = BTreeSet::new();
    let mut unlisted = Vec::new();

    for id in ids {
        if local.with(|store| store.is_listed(space, id))? {
            listed.insert(id);
        } else {
            unlisted.push(id);
        }
    }

    Ok((listed, unlisted))
}

pub(super) async fn push_deletions(
    local: &impl Local,
    client: &reqwest::Client,
    access: &Access,
) -> Result<Vec<Uuid>, Error> {
    let space = access.space;
    let docs = publishable_deletions(local, space)?;
    let mut refused = purge_all(
        client,
        access,
        docs,
        Erased::Docs,
        |store, id| store.deleted(id),
        local,
    )
    .await?;

    refused.extend(discard_rows(local, client, access).await?);
    locate_texts(local, access)?;
    let files = local.with(|store| store.erased_files(space))?;
    let erase = |store: &mut Store, id| store.file_erased(space, id);

    refused.extend(purge_all(client, access, files, Erased::Blobs, erase, local).await?);

    Ok(refused)
}
