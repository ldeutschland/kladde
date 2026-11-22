use kladde_store::{Note, Store};
use uuid::Uuid;

#[test]
fn encrypted_restart_search_and_atomic_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("notebook");
    let key = [11; 32];
    let mut store = Store::open(&path, &key).unwrap();
    let space = Uuid::new_v4();
    let mut notes: Vec<_> = (0..1000)
        .map(|i| Note {
            id: Uuid::new_v4(),
            space,
            kind: "page".into(),
            title: format!("Probe {i}"),
            body: "privateCanary".into(),
            parent: None,
            archived: false,
            props: "{}".into(),
            links: vec![],
            data: vec![1, 2],
            rev: 0,
        })
        .collect();
    store.save(&notes, false).unwrap();
    let start = std::time::Instant::now();

    assert_eq!(store.search(space, "Probe 711").unwrap(), [notes[711].id]);
    let elapsed = start.elapsed();

    println!("FTS 1000: {elapsed:?}");
    assert!(elapsed.as_millis() < 100);
    let first = notes[0].id;

    notes[0].rev = 1;
    notes[0].title = "after".into();
    assert!(store.save(&notes[..2], false).is_err());
    assert_eq!(store.get(first).unwrap().unwrap().title, "Probe 0");
    drop(store);
    let raw = std::fs::read(&path).unwrap();

    assert!(!raw.windows(13).any(|x| x == b"privateCanary"));
    assert!(!raw.starts_with(b"SQLite format"));
    assert!(Store::open(&path, &[9; 32]).is_err());
    let store = Store::open(&path, &key).unwrap();

    assert_eq!(store.get(first).unwrap().unwrap().title, "Probe 0");
}

#[test]
fn archives_restore_original_revisions_attachments_and_history_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = Store::open(&dir.path().join("source"), &[2; 32]).unwrap();
    let mut dest = Store::open(&dir.path().join("restored"), &[3; 32]).unwrap();
    let space = Uuid::new_v4();
    let file = Uuid::new_v4();
    let asset = format!("asset:{space}:{file}");
    let mut note = Note {
        id: space,
        space,
        kind: "workspace".into(),
        title: "Original".into(),
        body: String::new(),
        parent: None,
        archived: false,
        props: "{}".into(),
        links: vec![],
        data: vec![0, 0],
        rev: 0,
    };

    source.save(&[note.clone()], false).unwrap();
    note.title = "Updated".into();
    note.rev = 1;
    source.save(&[note], false).unwrap();
    source.set_state(&asset, b"encrypted fixture").unwrap();
    let mut invalid = source.archive(space).unwrap();

    invalid.history[0].1 = 9;
    assert!(dest.restore_archive(space, invalid).is_err());
    assert!(dest.get(space).unwrap().is_none());
    dest.restore_archive(space, source.archive(space).unwrap())
        .unwrap();
    assert_eq!(dest.get(space).unwrap().unwrap().rev, 2);
    assert_eq!(dest.version(space, 1).unwrap().title, "Original");
    assert_eq!(dest.state(&asset).unwrap().unwrap(), b"encrypted fixture");
    assert!(
        dest.restore_archive(space, source.archive(space).unwrap())
            .is_err()
    );
}

#[test]
fn complete_backup_checks_attachments_in_prior_revisions() {
    use yrs::{Doc, Map, ReadTxn, StateVector, Transact};

    let id = Uuid::new_v4();
    let doc = Doc::new();
    let files = doc.get_or_insert_map("files");

    files.insert(&mut doc.transact_mut(), id.to_string(), "image");
    let space = Uuid::new_v4();
    let mut old = Note {
        id: Uuid::new_v4(),
        space,
        kind: "page".into(),
        title: "Page".into(),
        parent: None,
        archived: false,
        props: "{}".into(),
        links: vec![],
        body: String::new(),
        rev: 1,
        data: doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default()),
    };

    let history = serde_json::to_vec(&old).unwrap();

    files.remove(&mut doc.transact_mut(), &id.to_string());
    old.rev = 2;
    old.data = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let doc_id = old.id;
    let mut archive = kladde_store::Archive {
        notes: vec![old],
        history: vec![(doc_id, 1, 0, history)],
        files: vec![],
        owners: vec![],
    };

    assert_eq!(archive.missing_files().unwrap(), [(doc_id, id)]);
    archive.files.push((id, vec![1]));
    assert!(archive.missing_files().unwrap().is_empty());
}

#[test]
fn a_backup_record_never_weighs_less_than_its_encoding() {
    use kladde_store::Record;

    let note = Note {
        id: Uuid::new_v4(),
        space: Uuid::new_v4(),
        kind: "database".into(),
        title: "t".repeat(2048),
        body: "b".repeat(70_000),
        parent: Some(Uuid::new_v4()),
        archived: true,
        props: format!("{{\"a\":\"{}\"}}", "p".repeat(300)),
        links: (0..4096).map(|_| Uuid::new_v4()).collect(),
        data: vec![255; 300_000],
        rev: i64::MAX - 1,
    };

    let records = [
        Record::Note(note),
        Record::Version {
            id: Uuid::new_v4(),
            rev: i64::MAX - 1,
            time: i64::MAX,
            record: vec![1; 5],
        },
        Record::File {
            id: Uuid::new_v4(),
            doc: Uuid::new_v4(),
            bytes: vec![],
        },
        Record::Cause {
            id: Uuid::new_v4(),
            rev: i64::MAX - 1,
            cause: "restore".into(),
            origin: Some("remote".into()),
        },
        Record::Shared {
            id: Uuid::new_v4(),
            file: Uuid::new_v4(),
            rev: Some(i64::MAX - 1),
            state: i64::MAX,
        },
    ];

    for record in &records {
        let encoded = kladde_protocol::encode(record).unwrap();

        assert!(encoded.len() <= record.weight());
    }
}

#[test]
fn replaced_states_are_written_and_cleared_together() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("notebook"), &[5; 32]).unwrap();

    store.set_state("old", b"stale").unwrap();
    store.set_state("lock", b"held").unwrap();
    let written: [(String, &[u8]); 2] = [("old".into(), b"fresh"), ("new".into(), b"added")];

    store.replace_states(&written, &["lock"]).unwrap();
    assert_eq!(store.state("old").unwrap().unwrap(), b"fresh");
    assert_eq!(store.state("new").unwrap().unwrap(), b"added");
    assert!(store.state("lock").unwrap().is_none());
}
