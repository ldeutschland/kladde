use crate::{Error, Store, history, parts, shared_versions::LISTED_MAP};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;
use yrs::{Any, Map, Out, Transact};

pub type Hash = [u8; 32];

const HASHES: &str = "sha256";
const HISTORY: &str = "SELECT record FROM versions WHERE id=?1 ORDER BY rev DESC";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Listing {
    Unlisted,
    Unhashed,
    Hashed(Hash),
}

fn hash_of(item: &Any) -> Option<Hash> {
    let Any::String(text) = item else {
        return None;
    };

    let mut hash = [0; 32];

    hex::decode_to_slice(text.as_bytes(), &mut hash).ok()?;

    Some(hash)
}

fn listed_hashes(listed: Option<&Any>, count: usize) -> Option<Vec<Option<Hash>>> {
    let Some(listed) = listed else {
        return Some(vec![None; count]);
    };

    let Any::Array(items) = listed else {
        return None;
    };

    if items.len() != count {
        return None;
    }

    items.iter().map(|item| hash_of(item).map(Some)).collect()
}

fn listed_blobs(key: &str, meta: &Out) -> Option<Vec<(Uuid, Option<Hash>)>> {
    let Out::Any(Any::Map(fields)) = meta else {
        return None;
    };

    let id = parts::file_id(key).ok()?;
    let blobs = parts::listed_parts(meta).ok()?.unwrap_or_else(|| vec![id]);
    let hashes = listed_hashes(fields.get(HASHES), blobs.len())?;

    Some(blobs.into_iter().zip(hashes).collect())
}

fn listing_in(data: &[u8], blob: Uuid) -> Result<Listing, Error> {
    let (doc, files) = parts::opened(data, parts::FILES)?;
    let versions = doc.get_or_insert_map(LISTED_MAP);
    let tx = doc.transact();
    let found: Vec<Option<Hash>> = files
        .iter(&tx)
        .chain(versions.iter(&tx))
        .filter_map(|(key, meta)| listed_blobs(key, &meta))
        .flatten()
        .filter_map(|(listed, hash)| (listed == blob).then_some(hash))
        .collect();
    let distinct: BTreeSet<Hash> = found.iter().flatten().copied().collect();
    let mut hashes = distinct.into_iter();

    match (found.is_empty(), hashes.next(), hashes.next()) {
        (true, _, _) => Ok(Listing::Unlisted),
        (false, None, _) => Ok(Listing::Unhashed),
        (false, Some(hash), None) => Ok(Listing::Hashed(hash)),
        (false, Some(_), Some(_)) => Err(Error::Invalid),
    }
}

pub(crate) fn version_hashes(data: &[u8]) -> Result<BTreeMap<Uuid, Hash>, Error> {
    let (doc, versions) = parts::opened(data, LISTED_MAP)?;
    let tx = doc.transact();

    Ok(versions
        .iter(&tx)
        .filter_map(|(key, meta)| listed_blobs(key, &meta))
        .flatten()
        .filter_map(|(file, hash)| hash.map(|hash| (file, hash)))
        .collect())
}

impl Store {
    pub fn blob_listing(&self, space: Uuid, doc: Uuid, blob: Uuid) -> Result<Listing, Error> {
        let note = self.get(doc)?.filter(|note| note.space == space);
        let current = listing_in(&note.ok_or(Error::Invalid)?.data, blob)?;

        if current != Listing::Unlisted {
            return Ok(current);
        }

        self.listing_in_history(doc, blob)
    }

    fn listing_in_history(&self, doc: Uuid, blob: Uuid) -> Result<Listing, Error> {
        let mut statement = self.0.prepare(HISTORY)?;
        let records = statement.query_map([doc.to_string()], |r| r.get::<_, Vec<u8>>(0))?;

        for record in records {
            let kept = history::decode(&record?)?;
            let listing = listing_in(&kept.data, blob)?;

            if listing != Listing::Unlisted {
                return Ok(listing);
            }
        }

        Ok(Listing::Unlisted)
    }
}
