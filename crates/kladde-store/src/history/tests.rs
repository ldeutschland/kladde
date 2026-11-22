use super::{
    LARGE_CHANGE, MAX_LABEL_CHARS, REMOTE, Version,
    automatic_versions::{DAY, HOUR, MAX_ANCHORS, UNVERSIONED_KIND, capture, mark_saved},
    change_size::{gains_much, loses_much},
};

use crate::{Note, Store};
use rusqlite::params;
use uuid::Uuid;

const MINUTE: i64 = 60;
const NOW: i64 = 400 * DAY;
const SPACE: Uuid = Uuid::from_u128(0x67e55044_10b1_426f_9247_bb680e5fe0c8);
const SENTENCE: &str = "Ein Satz mit etlichen Worten. ";

fn open() -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("notebook"), &[5; 32]).unwrap();

    (store, dir)
}

fn page(id: Uuid, rev: i64, body: &str) -> Note {
    Note {
        id,
        space: SPACE,
        kind: "page".into(),
        title: format!("Version {rev}"),
        body: body.into(),
        parent: None,
        archived: false,
        props: "{}".into(),
        links: vec![],
        data: vec![0, 0],
        rev,
    }
}

fn stored(store: &mut Store) -> Uuid {
    let id = Uuid::new_v4();

    store.save(&[page(id, 0, "")], false).unwrap();

    id
}

struct Writer<'a> {
    store: &'a Store,
    id: Uuid,
    rev: i64,
    body: String,
    remote: bool,
}

impl Writer<'_> {
    fn writes(&mut self, time: i64, body: &str) {
        let previous = page(self.id, self.rev, &self.body);
        let next = page(self.id, self.rev + 1, body);

        capture(&self.store.0, &previous, &next, time, self.remote).unwrap();
        mark_saved(&self.store.0, &self.id.to_string(), time).unwrap();
        self.rev += 1;
        self.body = body.into();
    }

    fn types(&mut self, times: &[i64]) {
        for time in times {
            let longer = format!("{} wort", self.body);

            self.writes(*time, &longer);
        }
    }

    fn listed(&self) -> Vec<Version> {
        self.store.versions(self.id).unwrap()
    }

    fn revs(&self) -> Vec<i64> {
        self.listed().into_iter().map(|v| v.rev).collect()
    }

    fn times(&self) -> Vec<i64> {
        self.listed().into_iter().map(|v| v.time - NOW).collect()
    }

    fn body_of(&self, rev: i64) -> String {
        self.store.version(self.id, rev).unwrap().body
    }
}

fn writer(store: &mut Store) -> Writer<'_> {
    let id = stored(store);

    mark_saved(&store.0, &id.to_string(), NOW).unwrap();

    Writer {
        store,
        id,
        rev: 1,
        body: String::new(),
        remote: false,
    }
}

#[test]
fn a_pause_keeps_the_state_the_writing_ended_with() {
    let (mut store, _dir) = open();
    let mut page = writer(&mut store);

    page.types(&[NOW + 100, NOW + 101, NOW + 110, NOW + 145, NOW + 146]);
    page.types(&[NOW + 170]);
    assert_eq!(page.revs(), [4, 1]);
    assert_eq!(page.times(), [145, 100]);
    assert_eq!(page.body_of(4), " wort wort wort");
}

#[test]
fn writing_without_a_pause_is_kept_every_few_minutes() {
    let (mut store, _dir) = open();
    let mut page = writer(&mut store);
    let steady: Vec<i64> = (1..=40).map(|step| NOW + step * 10).collect();

    page.types(&steady);
    assert_eq!(page.times(), [370, 190, 10]);
}

#[test]
fn a_large_loss_is_kept_at_once_and_marked() {
    let (mut store, _dir) = open();
    let mut page = writer(&mut store);
    let text = SENTENCE.repeat(20);

    page.writes(NOW + 1, &text);
    page.writes(NOW + 2, &format!("{text}mehr"));
    page.writes(NOW + 3, "x");
    page.writes(NOW + 4, "xy");
    let causes: Vec<_> = page.listed().into_iter().map(|v| v.cause).collect();

    assert_eq!(page.revs(), [3, 1]);
    assert_eq!(causes, [Some(LARGE_CHANGE.to_string()), None]);
    assert_eq!(page.body_of(3), format!("{text}mehr"));
}

#[test]
fn a_large_addition_is_kept_at_once_and_marked() {
    let (mut store, _dir) = open();
    let mut page = writer(&mut store);
    let text = SENTENCE.repeat(4);

    page.writes(NOW + 1, &text);
    page.writes(NOW + 2, &format!("{text}{}", SENTENCE.repeat(40)));
    page.writes(NOW + 3, &format!("{text}{} und", SENTENCE.repeat(40)));
    let causes: Vec<_> = page.listed().into_iter().map(|v| v.cause).collect();

    assert_eq!(page.revs(), [2, 1]);
    assert_eq!(causes, [Some(LARGE_CHANGE.to_string()), None]);
    assert_eq!(page.body_of(2), text);
}

#[test]
fn pasting_a_link_or_filling_a_nearly_empty_page_is_no_large_addition() {
    let note = SENTENCE.repeat(4);
    let link = " https://example.org/ein/ziemlich/langer/pfad/zu/einer/seite";

    assert!(!gains_much(&note, &format!("{note}{link}")));
    assert!(!gains_much("", &SENTENCE.repeat(100)));
    assert!(!gains_much(
        "Titel und ein Stichwort",
        &SENTENCE.repeat(100)
    ));
    assert!(gains_much(&note, &format!("{note}{}", SENTENCE.repeat(20))));
    let long = SENTENCE.repeat(200);

    assert!(!gains_much(
        &long,
        &format!("{long}{}", SENTENCE.repeat(40))
    ));
    assert!(gains_much(
        &long,
        &format!("{long}{}", SENTENCE.repeat(100))
    ));
}

#[test]
fn a_requested_cause_survives_the_large_change_that_follows() {
    let (mut store, _dir) = open();
    let id = stored(&mut store);
    let text = SENTENCE.repeat(20);

    store.save(&[page(id, 1, &text)], false).unwrap();
    assert_eq!(store.keep_version(id, None, Some("ai")).unwrap(), 2);
    store.save(&[page(id, 2, "x")], false).unwrap();
    let listed = store.versions(id).unwrap();

    assert_eq!(listed[0].rev, 2);
    assert_eq!(listed[0].cause.as_deref(), Some("ai"));
}

#[test]
fn a_large_change_from_another_device_is_marked_as_such() {
    let (mut store, _dir) = open();
    let mut page = writer(&mut store);

    page.writes(NOW + 1, &SENTENCE.repeat(20));
    page.remote = true;
    page.writes(NOW + 2, "x");
    let origin = |rev: i64| -> Option<String> {
        let found = page.store.0.query_row(
            "SELECT origin FROM versions WHERE id=?1 AND rev=?2",
            params![page.id.to_string(), rev],
            |r| r.get(0),
        );

        found.unwrap()
    };

    assert_eq!(origin(2).as_deref(), Some(REMOTE));
    assert_eq!(origin(1), None);
}

#[test]
fn rearranged_or_renumbered_text_is_no_loss() {
    let list: Vec<String> = (1..=80).map(|n| format!("{n}. Punkt {n}")).collect();
    let mut longer = vec!["1. Neu".to_string()];

    longer.extend((1..=80).map(|n| format!("{}. Punkt {n}", n + 1)));
    assert!(!loses_much(&list.join("\n"), &longer.join("\n")));
    let head = "| Name   | Ort    |\n| ------ | ------ |\n";
    let table = format!("{head}{}", "| Ada    | London |\n".repeat(30));
    let padded = table.replace("  |", "     |").replace("-- |", "----- |");

    assert!(!loses_much(&table, &padded));
    let moved = format!("{}\n{}", &table[160..], &table[..160]);

    assert!(!loses_much(&table, &moved));
    assert!(!loses_much(&table, &format!("{table}{table}")));
    assert!(loses_much(&table, &table[..table.len() / 2]));
}

#[test]
fn small_edits_are_no_loss_and_a_lost_paragraph_is() {
    let paragraph = "Ein Absatz mit genug Text, damit sein Verlust nicht als Tippfehler gilt.";

    assert!(!loses_much("kurz", "kurzer"));
    assert!(!loses_much("ein paar Worte", "x"));
    assert!(!loses_much(paragraph, &paragraph.replace("genug", "viel")));
    assert!(loses_much(paragraph, "x"));
    assert!(loses_much(&SENTENCE.repeat(100), &SENTENCE.repeat(88)));
    assert!(!loses_much(&SENTENCE.repeat(100), &SENTENCE.repeat(95)));
}

#[test]
fn a_clock_set_back_does_not_block_new_versions() {
    let (mut store, _dir) = open();
    let mut page = writer(&mut store);

    page.types(&[NOW + 1, NOW - 2 * HOUR]);
    assert_eq!(page.revs(), [2, 1]);
}

#[test]
fn routine_versions_thin_out_by_age() {
    let (mut store, _dir) = open();
    let mut page = writer(&mut store);
    let minutes = [5, 7, 9, 12].map(|count| NOW + count * MINUTE);

    page.types(&minutes);
    page.types(&[NOW + 2 * HOUR]);
    assert_eq!(page.revs(), [5, 4, 3]);
    page.types(&[NOW + 30 * HOUR, NOW + 31 * HOUR]);
    assert_eq!(page.revs(), [7, 6, 5]);
    page.types(&[NOW + 40 * DAY]);
    assert_eq!(page.revs(), [8, 7]);
    page.types(&[NOW + 500 * DAY]);
    assert_eq!(page.revs(), [9]);
    assert_eq!(page.times(), [500 * DAY]);
}

#[test]
fn marked_versions_outlast_routine_ones() {
    let (mut store, _dir) = open();
    let mut page = writer(&mut store);
    let text = SENTENCE.repeat(20);

    page.writes(NOW + 5 * MINUTE, &text);
    page.writes(NOW + 7 * MINUTE, "x");
    page.types(&[NOW + 9 * MINUTE, NOW + 12 * MINUTE, NOW + 2 * HOUR]);
    assert_eq!(page.revs(), [5, 4, 3, 2]);
    page.types(&[NOW + 20 * DAY]);
    assert_eq!(page.revs(), [6, 5, 2]);
    assert_eq!(page.body_of(2), text);
    page.types(&[NOW + 45 * DAY]);
    assert_eq!(page.revs(), [7, 6, 5]);
}

#[test]
fn only_the_newest_marked_versions_stay_marked() {
    let (mut store, _dir) = open();
    let mut page = writer(&mut store);
    let text = SENTENCE.repeat(20);

    for step in 0..=MAX_ANCHORS {
        page.writes(NOW + step * 10, &text);
        page.writes(NOW + step * 10 + 1, "x");
    }

    let listed = page.listed();
    let marked = listed.iter().filter(|v| v.cause.is_some()).count();
    let oldest = listed.iter().find(|v| v.rev == 2).unwrap();

    assert_eq!(listed.len() as i64, MAX_ANCHORS + 2);
    assert_eq!(marked as i64, MAX_ANCHORS);
    assert_eq!(oldest.cause, None);
}

#[test]
fn named_versions_survive_thinning() {
    let (mut store, _dir) = open();
    let mut page = writer(&mut store);
    let minutes = [5, 7, 9].map(|count| NOW + count * MINUTE);

    page.types(&minutes);
    let (store, id) = (page.store, page.id);

    store.label_version(id, 2, Some("  Abgabe  ")).unwrap();
    page.types(&[NOW + 500 * DAY]);
    let labels: Vec<_> = page.listed().into_iter().map(|v| v.label).collect();

    assert_eq!(page.revs(), [4, 2]);
    assert_eq!(labels, [None, Some("Abgabe".to_string())]);
    store.label_version(id, 2, None).unwrap();
    page.types(&[NOW + 501 * DAY]);
    assert_eq!(page.revs(), [5, 4]);
}

#[test]
fn keeping_the_current_state_needs_no_pause() {
    let (mut store, _dir) = open();
    let id = stored(&mut store);
    let mut edit = page(id, 1, "eins");

    store.save(&[edit.clone()], false).unwrap();
    assert_eq!(store.keep_version(id, None, Some("restore")).unwrap(), 2);
    assert_eq!(store.keep_version(id, Some("Vor Umbau"), None).unwrap(), 2);
    assert_eq!(store.keep_version(id, None, None).unwrap(), 2);
    edit.rev = 2;
    store.save(&[edit], false).unwrap();
    let listed = store.versions(id).unwrap();

    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].label.as_deref(), Some("Vor Umbau"));
    assert_eq!(listed[0].cause.as_deref(), Some("restore"));
    assert_eq!(store.version(id, 2).unwrap().body, "eins");
    store.delete_version(id, 2).unwrap();
    assert_eq!(store.versions(id).unwrap().len(), 1);
}

#[test]
fn a_file_edit_marks_the_state_before_it() {
    let (mut store, _dir) = open();
    let id = stored(&mut store);
    let rev = store.keep_version(id, None, Some("file")).unwrap();
    let listed = store.versions(id).unwrap();

    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].rev, rev);
    assert_eq!(listed[0].cause.as_deref(), Some("file"));
}

#[test]
fn labels_and_causes_are_checked() {
    let (mut store, _dir) = open();
    let id = stored(&mut store);
    let long = "x".repeat(MAX_LABEL_CHARS + 1);

    for label in ["", "   ", "a\nb", long.as_str()] {
        assert!(store.keep_version(id, Some(label), None).is_err());
    }

    for cause in [LARGE_CHANGE, "", "sync"] {
        assert!(store.keep_version(id, None, Some(cause)).is_err());
    }

    assert!(store.label_version(id, 7, Some("fehlt")).is_err());
    assert!(store.keep_version(Uuid::new_v4(), None, None).is_err());
    assert!(store.versions(id).unwrap().is_empty());
}

#[test]
fn directory_documents_keep_no_versions() {
    let (mut store, _dir) = open();
    let id = Uuid::new_v4();
    let mut shard = page(id, 0, "");

    shard.kind = UNVERSIONED_KIND.into();
    store.save(&[shard.clone()], false).unwrap();
    let record = serde_json::to_vec(&shard).unwrap();

    store
        .0
        .execute(
            "INSERT INTO versions(id,rev,time,record) VALUES(?1,0,?2,?3)",
            params![id.to_string(), NOW, record],
        )
        .unwrap();
    shard.rev = 1;
    store.save(&[shard], false).unwrap();
    assert!(store.versions(id).unwrap().is_empty());
}

#[test]
fn an_older_store_gains_what_the_history_needs() {
    const OLDER: &str = "ALTER TABLE versions DROP COLUMN label; ALTER TABLE versions DROP COLUMN cause; DROP TABLE save_times; PRAGMA user_version=4;";
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notebook");
    let mut store = Store::open(&path, &[5; 32]).unwrap();
    let id = stored(&mut store);

    store.keep_version(id, None, None).unwrap();
    store.0.execute_batch(OLDER).unwrap();
    drop(store);
    let mut store = Store::open(&path, &[5; 32]).unwrap();

    store.label_version(id, 1, Some("Bestand")).unwrap();
    store.save(&[page(id, 1, "weiter")], false).unwrap();
    let listed = store.versions(id).unwrap();

    assert_eq!(listed[0].label.as_deref(), Some("Bestand"));
    assert_eq!(listed[0].cause, None);
    drop(store);
    assert!(Store::open(&path, &[5; 32]).is_ok());
}

#[test]
fn versions_written_as_json_stay_readable() {
    let (mut store, _dir) = open();
    let id = stored(&mut store);
    let old = page(id, 1, "");
    let record = serde_json::to_vec(&old).unwrap();

    store
        .0
        .execute(
            "INSERT INTO versions(id,rev,time,record) VALUES(?1,1,?2,?3)",
            params![id.to_string(), NOW, record],
        )
        .unwrap();
    assert_eq!(store.version(id, 1).unwrap(), old);
    assert!(store.version(id, 2).is_err());
}
