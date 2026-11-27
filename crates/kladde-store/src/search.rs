use crate::readable::{excerpt, readable, tidy};
use crate::{Error, Note, Store, listing, uuid_col};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use uuid::Uuid;
use yrs::{
    Any, Doc, Map, MapRef, Out, ReadTxn, Transact, Update, Xml, XmlFragment, XmlFragmentRef,
};

#[derive(Serialize)]
pub struct SearchHit {
    pub doc: Uuid,
    pub file: Option<String>,
    pub name: String,
    pub snippet: String,
    pub offset: u32,
    pub page: u32,
    pub matched: String,
}

#[derive(Serialize)]
pub struct Attachment {
    pub file: Uuid,
    pub name: String,
    pub status: String,
}

#[derive(Serialize)]
pub struct Passage {
    pub name: String,
    pub status: String,
    pub text: String,
    pub page: u32,
    pub next_offset: Option<u32>,
}

pub struct AttachmentJob {
    pub space: Uuid,
    pub doc: Uuid,
    pub file: Uuid,
    pub name: String,
}

pub struct ExtractedText {
    pub doc: Uuid,
    pub file: Uuid,
    pub status: String,
    pub text: String,
}

const EXCERPT_LEAD: u32 = 60;
const EXCERPT_WINDOW: u32 = 240;

pub(super) fn index_words(db: &Connection, id: &str) -> Result<(), Error> {
    db.execute("DELETE FROM words WHERE id=?1", [id])?;
    let listed: Option<(String, String, String)> = db
        .query_row(
            "SELECT space,title,body FROM notes WHERE id=?1 AND archived=0 AND kind!='index'",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if let Some((space, title, body)) = listed {
        db.execute(
            "INSERT INTO words VALUES(?1,?2,?3,?4)",
            params![id, space, title, readable(&body)],
        )?;
    }

    Ok(())
}

pub(super) fn reindex(db: &Connection) -> Result<(), Error> {
    db.execute("DELETE FROM words", [])?;
    let ids = db
        .prepare("SELECT id FROM notes WHERE archived=0 AND kind!='index'")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    for id in ids {
        index_words(db, &id)?;
    }

    Ok(())
}

fn file_excerpt(window: &str, offset: u32, total: u32) -> String {
    let start = offset.saturating_sub(EXCERPT_LEAD) as usize;
    let shown = window.chars().count();

    excerpt(
        window,
        offset as usize - start,
        start > 0,
        start + shown < total as usize,
    )
}

pub(super) fn backfill(db: &Connection) -> Result<(), Error> {
    let mut stmt = db.prepare(
        "SELECT id FROM notes WHERE kind IN ('workspace','page','row','database')
         AND (instr(body,'kladde-file:') OR instr(data,CAST('kladde-file:' AS BLOB)))",
    )?;

    for id in stmt.query_map([], |r| uuid_col(r, 0))? {
        let note = Store::read_note(db, id?)?.ok_or(Error::Invalid)?;

        match refresh_files(db, &note) {
            Ok(()) | Err(Error::Invalid) => {}
            Err(error) => return Err(error),
        }
    }

    Ok(())
}

fn artwork_in(note: &Note) -> Result<BTreeSet<(Uuid, Uuid)>, Error> {
    let mut found = BTreeSet::new();

    if !note.data.windows(12).any(|w| w == b"kladde-file:") {
        return Ok(found);
    }

    let doc = Doc::new();
    let pages = doc.get_or_insert_map("pages");

    doc.transact_mut()
        .apply_update(Update::decode_complete_v1(&note.data).map_err(|_| Error::Invalid)?)
        .map_err(|_| Error::Invalid)?;
    let tx = doc.transact();

    for (key, value) in pages.iter(&tx) {
        let (Ok(owner), Out::Any(Any::Map(page))) = (Uuid::parse_str(key), value) else {
            continue;
        };

        if owner == note.space {
            continue;
        }

        for prop in ["icon", "cover"] {
            if let Some(Any::String(url)) = page.get(prop)
                && let Some(key) = url.strip_prefix("kladde-file:")
                && let Ok(file) = Uuid::parse_str(key)
            {
                found.insert((owner, file));
            }
        }
    }

    Ok(found)
}

fn stored_artwork(db: &Connection, note: &Note) -> Result<BTreeSet<(Uuid, Uuid)>, Error> {
    Ok(db
        .prepare("SELECT a.doc,a.file FROM page_artwork a JOIN listing l ON l.id=a.doc WHERE a.space=?1 AND l.shard=?2")?
        .query_map(params![note.space.to_string(), note.id.to_string()], |row| {
            Ok((uuid_col(row, 0)?, uuid_col(row, 1)?))
        })?
        .collect::<Result<_, _>>()?)
}

fn refresh_artwork(db: &Connection, note: &Note) -> Result<(), Error> {
    let space = note.space.to_string();
    let previous = stored_artwork(db, note)?;
    let current = artwork_in(note)?;

    if previous.is_empty() && current.is_empty() {
        return Ok(());
    }

    let kept: BTreeSet<Uuid> = listing::keys_of(&note.data)?.into_iter().collect();

    for (doc, file) in previous.difference(&current) {
        if !kept.contains(doc) && listing::listed_elsewhere(db, note, *doc)? {
            continue;
        }

        db.execute(
            "DELETE FROM page_artwork WHERE space=?1 AND doc=?2 AND file=?3",
            params![space, doc.to_string(), file.to_string()],
        )?;
    }

    for (doc, file) in current.difference(&previous) {
        db.execute(
            "INSERT OR IGNORE INTO page_artwork VALUES(?1,?2,?3)",
            params![space, doc.to_string(), file.to_string()],
        )?;
    }

    let changed: BTreeSet<_> = current
        .symmetric_difference(&previous)
        .map(|(doc, _)| *doc)
        .collect();
    for id in changed {
        if let Some(page) = Store::read_note(db, id)?
            && page.space == note.space
        {
            refresh_files(db, &page)?;
        }
    }

    Ok(())
}

const FILE_LINK_PREFIX: &str = "kladde-file:";
const MAX_FILE_NAME_CHARS: usize = 255;
const UUID_TEXT_LENGTH: usize = 36;

fn may_reference_files(note: &Note, artwork: &[String]) -> bool {
    if !matches!(note.kind.as_str(), "page" | "row" | "database") {
        return false;
    }

    !artwork.is_empty()
        || note.body.contains(FILE_LINK_PREFIX)
        || note
            .data
            .windows(FILE_LINK_PREFIX.len())
            .any(|window| window == FILE_LINK_PREFIX.as_bytes())
}

fn file_link_keys<T: ReadTxn>(
    note: &Note,
    artwork: &[String],
    blocks: &XmlFragmentRef,
    tx: &T,
) -> Vec<String> {
    let mut keys = artwork.to_vec();

    for element in blocks
        .successors(tx)
        .filter_map(|node| node.into_xml_element())
    {
        if let Some(Out::Any(Any::String(url))) = element.get_attribute(tx, "url")
            && let Some(key) = url.strip_prefix(FILE_LINK_PREFIX)
        {
            keys.push(key.to_string());
        }
    }

    let linked = note.body.split(FILE_LINK_PREFIX).skip(1);

    keys.extend(
        linked
            .filter_map(|tail| tail.get(..UUID_TEXT_LENGTH))
            .map(str::to_string),
    );

    keys
}

fn file_name<T: ReadTxn>(files: &MapRef, tx: &T, key: &str) -> Option<String> {
    let Some(Out::Any(Any::Map(meta))) = files.get(tx, key) else {
        return None;
    };

    Some(match meta.get("name") {
        Some(Any::String(name)) => name
            .chars()
            .filter(|c| !c.is_control())
            .take(MAX_FILE_NAME_CHARS)
            .collect(),
        _ => String::new(),
    })
}

fn referenced_files(note: &Note, artwork: &[String]) -> Result<BTreeMap<Uuid, String>, Error> {
    let mut found = BTreeMap::new();

    if !may_reference_files(note, artwork) {
        return Ok(found);
    }

    let doc = Doc::new();
    let files = doc.get_or_insert_map("files");
    let blocks = doc.get_or_insert_xml_fragment("blocks");

    doc.transact_mut()
        .apply_update(Update::decode_complete_v1(&note.data).map_err(|_| Error::Invalid)?)
        .map_err(|_| Error::Invalid)?;
    let tx = doc.transact();

    for key in file_link_keys(note, artwork, &blocks, &tx) {
        let Ok(id) = Uuid::parse_str(&key) else {
            continue;
        };

        if id.get_version_num() != 4 || found.contains_key(&id) {
            continue;
        }

        if let Some(name) = file_name(&files, &tx, &key) {
            found.insert(id, name);
        }
    }

    Ok(found)
}

pub(super) fn refresh_files(db: &Connection, note: &Note) -> Result<(), Error> {
    if listing::lists(&note.kind) {
        return refresh_artwork(db, note);
    }

    let doc = note.id.to_string();
    let artwork = db
        .prepare("SELECT file FROM page_artwork WHERE space=?1 AND doc=?2")?
        .query_map(params![note.space.to_string(), doc], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?;
    let mut current = referenced_files(note, &artwork)?;
    let mut stmt = db.prepare("SELECT rowid,file,name FROM page_files WHERE doc=?1")?;
    let old = stmt
        .query_map([&doc], |r| {
            Ok((r.get::<_, i64>(0)?, uuid_col(r, 1)?, r.get::<_, String>(2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (row, file, name) in old {
        if current.get(&file) == Some(&name) {
            current.remove(&file);
            continue;
        }

        db.execute("DELETE FROM file_words WHERE rowid=?1", [row])?;
        db.execute("DELETE FROM page_files WHERE rowid=?1", [row])?;
    }

    for (file, name) in current {
        db.execute(
            "INSERT INTO page_files(doc,file,name) VALUES(?1,?2,?3)",
            params![doc, file.to_string(), name],
        )?;
        db.execute(
            "INSERT INTO file_words(rowid,name,body) VALUES(?1,?2,'')",
            params![db.last_insert_rowid(), name],
        )?;
    }

    Ok(())
}

const MAX_QUERY_BYTES: usize = 1024;
const MAX_QUERY_TERMS: usize = 16;
const CONTENT_SEARCH: &str = "WITH hits AS MATERIALIZED (
                SELECT n.id AS doc,NULL AS file,'' AS name,substr(snippet(words,3,'','',' … ',18),1,360) AS snippet,
                       0 AS file_row,words.rank AS score
                FROM words JOIN notes n ON n.id=words.id
                WHERE words MATCH ?1 AND words.space=?2 AND n.archived=0 AND n.kind IN ('page','row','database') AND (?3 IS NULL OR n.parent=?3)
                UNION ALL
                SELECT f.doc,f.file,f.name,'',f.rowid,file_words.rank
                FROM file_words JOIN page_files f ON f.rowid=file_words.rowid JOIN notes n ON n.id=f.doc
                WHERE file_words MATCH ?1 AND n.space=?2 AND n.archived=0 AND (?3 IS NULL OR n.parent=?3)
                ORDER BY score LIMIT 100
             ), positions AS MATERIALIZED (
                SELECT h.*, instr(highlight(file_words,1,char(30),char(31)),char(30)) AS first,
                       instr(highlight(file_words,1,char(30),char(31)),char(31)) AS last
                FROM hits h JOIN file_words ON file_words.rowid=h.file_row WHERE file_words MATCH ?1
             )
             SELECT doc,file,name,snippet,0,0,'',score,0 FROM hits WHERE file IS NULL
             UNION ALL
             SELECT p.doc,p.file,p.name,substr(w.body,max(1,p.first-?4),?5),max(0,p.first-1),
                length(substr(w.body,1,max(0,p.first-1)))-length(replace(substr(w.body,1,max(0,p.first-1)),char(12),'')),
                substr(w.body,p.first,min(160,max(0,p.last-p.first-1))),p.score,length(w.body)
             FROM positions p JOIN file_words w ON w.rowid=p.file_row ORDER BY score";

fn search_terms(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .take(MAX_QUERY_TERMS)
        .map(|term| format!("\"{}\"*", term.replace('"', "\"\"")))
        .collect()
}

fn search_hit(row: &rusqlite::Row<'_>) -> rusqlite::Result<SearchHit> {
    let file: Option<String> = row.get(1)?;
    let text: String = row.get(3)?;
    let offset: u32 = row.get(4)?;
    let matched: String = row.get(6)?;
    let snippet = match &file {
        None => tidy(&text),
        Some(_) if matched.is_empty() => String::new(),
        Some(_) => file_excerpt(&text, offset, row.get(8)?),
    };

    Ok(SearchHit {
        doc: uuid_col(row, 0)?,
        file,
        name: row.get(2)?,
        snippet,
        offset,
        page: row.get(5)?,
        matched,
    })
}

impl Store {
    pub fn search_content(
        &self,
        space: Uuid,
        query: &str,
        parent: Option<Uuid>,
    ) -> Result<Vec<SearchHit>, Error> {
        if query.len() > MAX_QUERY_BYTES {
            return Err(Error::Invalid);
        }

        let terms = search_terms(query);

        if terms.is_empty() {
            return Ok(vec![]);
        }

        let mut stmt = self.0.prepare(CONTENT_SEARCH)?;

        Ok(stmt
            .query_map(
                params![
                    terms.join(" AND "),
                    space.to_string(),
                    parent.map(|id| id.to_string()),
                    EXCERPT_LEAD,
                    EXCERPT_WINDOW
                ],
                search_hit,
            )?
            .collect::<Result<_, _>>()?)
    }

    pub fn search(&self, space: Uuid, query: &str) -> Result<Vec<Uuid>, Error> {
        let mut seen = HashSet::new();

        Ok(self
            .search_content(space, query, None)?
            .into_iter()
            .map(|hit| hit.doc)
            .filter(|doc| seen.insert(*doc))
            .collect())
    }

    pub fn attachments(
        &self,
        space: Uuid,
        doc: Uuid,
        offset: u32,
    ) -> Result<Vec<Attachment>, Error> {
        Ok(self.0.prepare(
            "SELECT f.file,f.name,f.status FROM page_files f JOIN notes n ON n.id=f.doc
             WHERE n.space=?1 AND n.id=?2 AND n.archived=0 ORDER BY f.name,f.file LIMIT 50 OFFSET ?3"
        )?.query_map(params![space.to_string(),doc.to_string(),offset], |r| Ok(Attachment {
            file: uuid_col(r,0)?, name:r.get(1)?,status:r.get(2)?,
        }))?.collect::<Result<_, _>>()?)
    }

    pub fn attachment_text(
        &self,
        space: Uuid,
        doc: Uuid,
        file: Uuid,
        offset: u32,
    ) -> Result<Passage, Error> {
        let (name, status, text, length, page): (String, String, String, u32, u32) = self
            .0
            .query_row(
                "SELECT f.name,f.status,substr(w.body,?4+1,8000),length(w.body),length(substr(w.body,1,?4))-length(replace(substr(w.body,1,?4),char(12),''))
             FROM page_files f JOIN file_words w ON w.rowid=f.rowid JOIN notes n ON n.id=f.doc
             WHERE n.space=?1 AND n.archived=0 AND f.doc=?2 AND f.file=?3",
                params![space.to_string(), doc.to_string(), file.to_string(), offset],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?
            .ok_or(Error::Invalid)?;
        let next = offset.saturating_add(8000);

        Ok(Passage {
            name,
            status,
            text,
            page,
            next_offset: (next < length).then_some(next),
        })
    }

    pub fn attachment_words(
        &self,
        space: Uuid,
        doc: Uuid,
        file: Uuid,
    ) -> Result<Option<ExtractedText>, Error> {
        Ok(self
            .0
            .query_row(
                "SELECT f.status,w.body FROM page_files f JOIN file_words w ON w.rowid=f.rowid JOIN notes n ON n.id=f.doc
             WHERE n.space=?1 AND n.archived=0 AND f.doc=?2 AND f.file=?3 AND f.status IN ('ready','partial')",
                params![space.to_string(), doc.to_string(), file.to_string()],
                |r| {
                    Ok(ExtractedText {
                        doc,
                        file,
                        status: r.get(0)?,
                        text: r.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn pending_attachments(&self, space: Uuid) -> Result<u32, Error> {
        Ok(self.0.query_row("SELECT count(*) FROM page_files f JOIN notes n ON n.id=f.doc WHERE n.space=?1 AND n.archived=0 AND f.status='pending'", [space.to_string()], |r|r.get(0))?)
    }

    pub fn next_attachment(&self) -> Result<Option<AttachmentJob>, Error> {
        Ok(self.0.query_row(
            "SELECT n.space,f.doc,f.file,f.name FROM page_files f JOIN notes n ON n.id=f.doc
             WHERE f.status='pending' AND f.retry_at<=unixepoch() AND n.archived=0 ORDER BY f.retry_at,f.rowid LIMIT 1",
            [], |r| Ok(AttachmentJob { space:uuid_col(r,0)?, doc:uuid_col(r,1)?, file:uuid_col(r,2)?, name:r.get(3)? })
        ).optional()?)
    }

    pub fn next_unshared_text(
        &self,
        space: Uuid,
        marker: &str,
    ) -> Result<Option<ExtractedText>, Error> {
        Ok(self.0.query_row(
            "SELECT f.doc,f.file,f.status,w.body FROM page_files f JOIN file_words w ON w.rowid=f.rowid JOIN notes n ON n.id=f.doc
             WHERE n.space=?1 AND n.archived=0 AND f.status IN ('ready','partial')
             AND NOT EXISTS(SELECT 1 FROM private_state s WHERE s.id=?2||f.file) ORDER BY f.rowid LIMIT 1",
            params![space.to_string(), marker],
            |r| Ok(ExtractedText { doc: uuid_col(r, 0)?, file: uuid_col(r, 1)?, status: r.get(2)?, text: r.get(3)? }),
        ).optional()?)
    }

    pub fn defer_attachment(&self, job: &AttachmentJob) -> Result<(), Error> {
        self.0.execute("UPDATE page_files SET retry_at=unixepoch()+60 WHERE doc=?1 AND file=?2 AND status='pending'",params![job.doc.to_string(),job.file.to_string()])?;

        Ok(())
    }

    pub fn finish_attachment(
        &mut self,
        job: &AttachmentJob,
        status: &str,
        text: &str,
    ) -> Result<(), Error> {
        if !matches!(status, "ready" | "partial" | "unreadable" | "unsupported")
            || text.len() > 1_048_576
        {
            return Err(Error::Invalid);
        }

        let tx = self.0.savepoint()?;
        let row: Option<i64> = tx.query_row(
            "UPDATE page_files SET status=?4 WHERE doc=?1 AND file=?2 AND name=?3 AND status='pending' RETURNING rowid",
            params![job.doc.to_string(),job.file.to_string(),job.name,status], |r|r.get(0)
        ).optional()?;

        if let Some(row) = row {
            tx.execute(
                "UPDATE file_words SET body=?1 WHERE rowid=?2",
                params![text, row],
            )?;
        }

        tx.commit()?;

        Ok(())
    }
}
