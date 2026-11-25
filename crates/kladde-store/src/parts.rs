use crate::{Error, Store};
use std::collections::BTreeSet;
use uuid::Uuid;
use yrs::{Any, Doc, Map, Out, Transact, Update};

pub const MAX_FILE_PARTS: usize = 65_536;
const FILES: &str = "files";

pub(crate) fn file_id(key: &str) -> Result<Uuid, Error> {
    let id: Uuid = key.parse().map_err(|_| Error::Invalid)?;

    if id.get_version_num() != 4 {
        return Err(Error::Invalid);
    }

    Ok(id)
}

fn part_id(item: &Any) -> Result<Uuid, Error> {
    match item {
        Any::String(text) => file_id(text),
        _ => Err(Error::Invalid),
    }
}

fn listed_parts(meta: &Out) -> Result<Option<Vec<Uuid>>, Error> {
    let Out::Any(Any::Map(fields)) = meta else {
        return Ok(None);
    };

    let Some(listed) = fields.get("parts") else {
        return Ok(None);
    };

    let Any::Array(items) = listed else {
        return Err(Error::Invalid);
    };

    if items.is_empty() || items.len() > MAX_FILE_PARTS {
        return Err(Error::Invalid);
    }

    let parts = items.iter().map(part_id).collect::<Result<Vec<_>, _>>()?;
    let distinct: BTreeSet<_> = parts.iter().collect();

    if distinct.len() != parts.len() {
        return Err(Error::Invalid);
    }

    Ok(Some(parts))
}

fn opened(data: &[u8], map: &str) -> Result<(Doc, yrs::MapRef), Error> {
    let doc = Doc::new();
    let entries = doc.get_or_insert_map(map);
    let update = Update::decode_complete_v1(data).map_err(|_| Error::Invalid)?;

    doc.transact_mut()
        .apply_update(update)
        .map_err(|_| Error::Invalid)?;
    Ok((doc, entries))
}

pub(crate) fn listed_ids(data: &[u8], map: &str) -> Result<BTreeSet<Uuid>, Error> {
    let (doc, entries) = opened(data, map)?;
    let tx = doc.transact();

    Ok(entries
        .keys(&tx)
        .filter_map(|key| file_id(key).ok())
        .collect())
}

pub(crate) fn file_blobs(data: &[u8]) -> Result<Vec<(Uuid, Vec<Uuid>)>, Error> {
    let (doc, files) = opened(data, FILES)?;
    let tx = doc.transact();
    let mut found = Vec::new();

    for (key, meta) in files.iter(&tx) {
        let Ok(id) = file_id(key) else {
            continue;
        };

        let blobs = match listed_parts(&meta) {
            Ok(Some(parts)) => parts,
            _ => vec![id],
        };

        found.push((id, blobs));
    }

    Ok(found)
}

pub(crate) fn stored_files(data: &[u8]) -> Result<Vec<Uuid>, Error> {
    Ok(file_blobs(data)?
        .into_iter()
        .flat_map(|(_, blobs)| blobs)
        .collect())
}

impl Store {
    pub fn file_parts(
        &self,
        space: Uuid,
        doc: Uuid,
        file: Uuid,
    ) -> Result<Option<Vec<Uuid>>, Error> {
        let Some(note) = self.get(doc)?.filter(|note| note.space == space) else {
            return Err(Error::Invalid);
        };

        let (doc, files) = opened(&note.data, FILES)?;
        let tx = doc.transact();

        match files.get(&tx, &file.to_string()) {
            Some(meta) => listed_parts(&meta),
            None => Ok(None),
        }
    }
}
