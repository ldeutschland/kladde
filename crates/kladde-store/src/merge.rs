use crate::{Error, Note, Store, notes::MAX_LINKS};
use uuid::Uuid;
use yrs::{Any, Doc, Map, MapRef, Out, ReadTxn, StateVector, Transact, Update, types::ToJson};

const LINK_PREFIX: &str = "kladde:";
const UUID_TEXT: usize = 36;
const WORKSPACE: &str = "workspace";

pub struct Incoming {
    doc: Doc,
    latest: Option<Note>,
}

impl Default for Incoming {
    fn default() -> Self {
        Self {
            doc: Doc::new(),
            latest: None,
        }
    }
}

impl Incoming {
    pub fn add(&mut self, mut note: Note) -> Result<(), Error> {
        if self
            .latest
            .as_ref()
            .is_some_and(|known| !same_document(known, &note))
        {
            return Err(Error::Invalid);
        }

        apply(&self.doc, &note.data)?;
        note.data = Vec::new();
        self.latest = Some(note);

        Ok(())
    }

    pub fn workspace_title(&self) -> Option<String> {
        let latest = self.latest.as_ref().filter(|note| note.kind == WORKSPACE)?;
        let meta = self.doc.get_or_insert_map("meta");
        let merged = text_entry(&meta, &self.doc.transact(), "title");

        Some(merged.unwrap_or_else(|| latest.title.clone()))
    }
}

pub fn wire_form(mut note: Note) -> Note {
    note.props = "{}".into();
    note.links.clear();

    if text_of(&note.data).is_some_and(|text| text == note.body) {
        note.body.clear();
    }

    note
}

impl Store {
    pub fn merge_all(
        &mut self,
        incoming: Incoming,
        checkpoint: &str,
        state: &[u8],
    ) -> Result<bool, Error> {
        let mut note = incoming.latest.ok_or(Error::Invalid)?;
        let old = self.get(note.id)?;

        if old
            .as_ref()
            .is_some_and(|known| !same_document(known, &note))
        {
            return Err(Error::Invalid);
        }

        let doc = Doc::new();
        let meta = doc.get_or_insert_map("meta");
        let properties = doc.get_or_insert_map("properties");

        if let Some(known) = &old {
            apply(&doc, &known.data)?;
        }

        let before = doc.transact().snapshot();

        apply(&doc, &full_state(&incoming.doc))?;
        let grew = doc.transact().snapshot() != before;

        derive(&doc, &meta, &properties, &mut note);

        if let Some((parent, archived)) = self.placed(&note)? {
            note.parent = parent;
            note.archived = archived;
        }

        note.rev = old.as_ref().map_or(0, |known| known.rev);
        note.data = full_state(&doc);

        if !grew && old.as_ref().is_some_and(|known| same_listing(known, &note)) {
            self.set_state(checkpoint, state)?;

            return Ok(false);
        }

        self.save_with(&[note], true, Some((checkpoint, state)))?;

        Ok(true)
    }
}

fn same_document(stored: &Note, incoming: &Note) -> bool {
    stored.id == incoming.id && stored.space == incoming.space && stored.kind == incoming.kind
}

fn same_listing(stored: &Note, incoming: &Note) -> bool {
    stored.title == incoming.title
        && stored.body == incoming.body
        && stored.parent == incoming.parent
        && stored.archived == incoming.archived
}

fn apply(doc: &Doc, data: &[u8]) -> Result<(), Error> {
    let update = Update::decode_complete_v1(data).map_err(|_| Error::Invalid)?;

    doc.transact_mut()
        .apply_update(update)
        .map_err(|_| Error::Invalid)
}

fn full_state(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn text_entry(meta: &MapRef, txn: &impl ReadTxn, key: &str) -> Option<String> {
    match meta.get(txn, key) {
        Some(Out::Any(Any::String(text))) => Some(text.to_string()),
        _ => None,
    }
}

fn text_of(data: &[u8]) -> Option<String> {
    let doc = Doc::new();
    let meta = doc.get_or_insert_map("meta");

    apply(&doc, data).ok()?;

    text_entry(&meta, &doc.transact(), "text")
}

fn derive(doc: &Doc, meta: &MapRef, properties: &MapRef, note: &mut Note) {
    let txn = doc.transact();

    if let Some(title) = text_entry(meta, &txn, "title") {
        note.title = title;
    }

    if let Some(body) = text_entry(meta, &txn, "text") {
        note.body = body;
    }

    note.props.clear();
    properties.to_json(&txn).to_json(&mut note.props);
    note.links = links_in(&note.body);
}

fn links_in(body: &str) -> Vec<Uuid> {
    let mut links: Vec<Uuid> = body
        .match_indices(LINK_PREFIX)
        .filter_map(|(index, _)| {
            let start = index + LINK_PREFIX.len();

            body.get(start..start + UUID_TEXT)?.parse::<Uuid>().ok()
        })
        .filter(|id| id.get_version_num() == 4)
        .collect();
    links.sort_unstable();
    links.dedup();
    links.truncate(MAX_LINKS);

    links
}
