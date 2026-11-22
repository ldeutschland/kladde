use kladde_store::{Note, Store};
use uuid::Uuid;
use yrs::{Any, Doc, Map, ReadTxn, StateVector, Transact};

const TEXT: &str = "Ein Satz mit etlichen Worten. ";

struct Device {
    store: Store,
    note: Note,
    _dir: tempfile::TempDir,
}

fn data(listed: &[Uuid], files: &[Uuid]) -> Vec<u8> {
    let doc = Doc::new();
    let versions = doc.get_or_insert_map("versions");
    let attached = doc.get_or_insert_map("files");

    for id in listed {
        versions.insert(&mut doc.transact_mut(), id.to_string(), Any::from(1.0));
    }

    for id in files {
        attached.insert(&mut doc.transact_mut(), id.to_string(), Any::from("Datei"));
    }

    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn device(space: Uuid, id: Uuid, kind: &str) -> Device {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("notebook"), &[5; 32]).unwrap();
    let note = Note {
        id,
        space,
        kind: kind.into(),
        title: "Seite".into(),
        body: String::new(),
        parent: None,
        archived: false,
        props: "{}".into(),
        links: vec![],
        data: data(&[], &[]),
        rev: 0,
    };

    store.save(std::slice::from_ref(&note), false).unwrap();

    Device {
        store,
        note: Note { rev: 1, ..note },
        _dir: dir,
    }
}

impl Device {
    fn page() -> Self {
        device(Uuid::new_v4(), Uuid::new_v4(), "page")
    }

    fn writes(&mut self, body: &str, listed: &[Uuid], remote: bool) {
        self.note.body = body.into();
        self.note.data = data(listed, &[]);
        let saved = self.store.save(std::slice::from_ref(&self.note), remote);

        saved.unwrap();
        self.note.rev += 1;
    }

    fn shares(&mut self) -> Vec<Uuid> {
        let (space, doc) = (self.note.space, self.note.id);
        let waiting = self.store.unshared_versions(space, doc).unwrap();
        let mut files = Vec::new();

        for (rev, record) in waiting {
            let file = Uuid::new_v4();

            self.store.store_asset(space, doc, file, &record).unwrap();
            self.store.mark_shared(doc, rev, file).unwrap();
            files.push(file);
        }

        files
    }

    fn reconciles(&mut self) -> (Vec<Uuid>, Vec<Uuid>) {
        let result = self.store.reconcile_shared(self.note.space, self.note.id);
        let result = result.unwrap();

        (
            result.own.into_iter().map(|v| v.file).collect(),
            result.gone,
        )
    }

    fn keeps_copy(&self, file: Uuid) -> bool {
        let key = format!("asset:{}:{file}", self.note.space);

        self.store.state(&key).unwrap().is_some()
    }

    fn revs(&self) -> Vec<i64> {
        let listed = self.store.versions(self.note.id).unwrap();

        listed.into_iter().map(|v| v.rev).collect()
    }
}

#[test]
fn a_named_version_is_offered_once_and_listed_after_the_page_names_it() {
    let mut a = Device::page();

    a.writes("Erster Stand", &[], false);
    a.writes("Zweiter Stand", &[], false);
    assert!(a.shares().is_empty());
    let named = a.store.keep_version(a.note.id, Some("Vor Umbau"), None);
    let rev = named.unwrap();
    let files = a.shares();

    assert_eq!(files.len(), 1);
    assert!(a.shares().is_empty());
    assert_eq!(a.reconciles(), (files.clone(), vec![]));
    a.writes("Zweiter Stand", &files, false);
    assert_eq!(a.reconciles(), (files.clone(), vec![]));
    let listed = a.store.versions(a.note.id).unwrap();
    let shared = listed.iter().find(|v| v.rev == rev).unwrap();

    assert_eq!(shared.file, Some(files[0].to_string()));
}

#[test]
fn a_version_removed_from_the_page_elsewhere_disappears_here() {
    let mut a = Device::page();

    a.writes("Stand", &[], false);
    let rev = a.store.keep_version(a.note.id, None, Some("file")).unwrap();
    let files = a.shares();

    a.writes("Stand", &files, false);
    a.reconciles();
    a.writes("Stand", &[], false);
    assert_eq!(a.reconciles(), (vec![], vec![]));
    assert!(!a.revs().contains(&rev));
    assert!(!a.keeps_copy(files[0]));
    assert_eq!(a.store.erased_files(a.note.space).unwrap(), files);
    assert!(a.shares().is_empty());
}

#[test]
fn a_version_that_loses_its_name_is_retracted_before_it_is_erased() {
    let mut a = Device::page();

    a.writes("Stand", &[], false);
    let rev = a
        .store
        .keep_version(a.note.id, Some("Entwurf"), None)
        .unwrap();
    let files = a.shares();

    a.writes("Stand", &files, false);
    a.reconciles();
    a.store.label_version(a.note.id, rev, None).unwrap();
    assert_eq!(a.reconciles(), (vec![], files.clone()));
    assert!(a.keeps_copy(files[0]));
    assert_eq!(a.reconciles(), (vec![], files.clone()));
    a.writes("Stand", &[], false);
    assert_eq!(a.reconciles(), (vec![], vec![]));
    assert!(!a.keeps_copy(files[0]));
    assert!(a.revs().contains(&rev));
}

#[test]
fn a_large_change_is_shared_only_by_the_device_that_made_it() {
    let mut a = Device::page();

    a.writes(&TEXT.repeat(20), &[], false);
    a.writes("x", &[], false);
    assert_eq!(a.shares().len(), 1);
    let mut b = Device::page();

    b.writes(&TEXT.repeat(20), &[], false);
    b.writes("x", &[], true);
    assert_eq!(b.revs().len(), 2);
    assert!(b.shares().is_empty());
}

#[test]
fn another_device_opens_a_listed_version_and_drops_its_copy_when_unlisted() {
    let mut a = Device::page();

    a.writes("Stand vor der Bearbeitung", &[], false);
    a.store.keep_version(a.note.id, None, Some("file")).unwrap();
    let record = a.store.unshared_versions(a.note.space, a.note.id).unwrap();
    let record = record[0].1.clone();
    let file = a.shares()[0];
    let (space, doc) = (a.note.space, a.note.id);
    let mut b = device(space, doc, "page");
    let unlisted = b.store.shared_version(space, doc, file, &record);

    assert!(unlisted.is_err());
    b.writes("Neuer Stand", &[file], true);
    b.store.store_asset(space, doc, file, &record).unwrap();
    let opened = b.store.shared_version(space, doc, file, &record).unwrap();

    assert_eq!(opened.body, "Stand vor der Bearbeitung");
    assert_eq!(b.reconciles(), (vec![], vec![]));
    assert!(b.keeps_copy(file));
    b.writes("Neuer Stand", &[], true);
    b.reconciles();
    assert!(!b.keeps_copy(file));
}

#[test]
fn a_record_of_another_page_or_kind_is_refused() {
    let mut a = Device::page();

    a.writes("Stand", &[], false);
    a.store
        .keep_version(a.note.id, Some("Version"), None)
        .unwrap();
    let record = a.store.unshared_versions(a.note.space, a.note.id).unwrap();
    let record = record[0].1.clone();
    let file = Uuid::new_v4();
    let mut other = device(a.note.space, Uuid::new_v4(), "page");

    other.writes("Andere Seite", &[file], true);
    let (space, doc) = (other.note.space, other.note.id);

    assert!(
        other
            .store
            .shared_version(space, doc, file, &record)
            .is_err()
    );
    let mut row = device(a.note.space, a.note.id, "row");

    row.writes("Zeile", &[file], true);
    let opened = row
        .store
        .shared_version(a.note.space, a.note.id, file, &record);
    assert!(opened.is_err());
    assert!(
        other
            .store
            .shared_version(space, doc, file, b"kein Datensatz")
            .is_err()
    );
}

#[test]
fn erasing_is_limited_to_listed_versions_and_never_takes_an_attachment() {
    let mut a = Device::page();

    a.writes("Stand", &[], false);
    let rev = a
        .store
        .keep_version(a.note.id, Some("Version"), None)
        .unwrap();
    let file = a.shares()[0];
    let (space, doc) = (a.note.space, a.note.id);

    assert!(a.store.erase_shared(space, doc, file).is_err());
    let attachment = Uuid::new_v4();

    a.store
        .store_asset(space, doc, attachment, b"Datei")
        .unwrap();
    a.note.data = data(&[file, attachment], &[attachment]);
    a.store.save(&[a.note.clone()], false).unwrap();
    a.note.rev += 1;
    assert!(a.store.erase_shared(space, doc, attachment).is_err());
    assert!(a.keeps_copy(attachment));
    a.store.erase_shared(space, doc, file).unwrap();
    assert!(!a.keeps_copy(file));
    assert!(!a.revs().contains(&rev));
    assert_eq!(a.store.erased_files(space).unwrap(), vec![file]);
}

#[test]
fn an_id_that_belongs_to_another_page_is_neither_opened_nor_erased() {
    let mut a = Device::page();

    a.writes("Stand", &[], false);
    let space = a.note.space;
    let neighbour = Note {
        id: Uuid::new_v4(),
        rev: 0,
        ..a.note.clone()
    };

    let saved = a.store.save(std::slice::from_ref(&neighbour), false);

    saved.unwrap();
    let attachment = Uuid::new_v4();
    let stored = a
        .store
        .store_asset(space, neighbour.id, attachment, b"Datei");
    stored.unwrap();
    a.store
        .keep_version(a.note.id, Some("Version"), None)
        .unwrap();
    let record = a.store.unshared_versions(space, a.note.id).unwrap();
    let record = record[0].1.clone();

    a.writes("Stand", &[attachment], true);
    let doc = a.note.id;

    assert!(a.store.erase_shared(space, doc, attachment).is_err());
    let claimed = a.store.shared_version(space, doc, attachment, &record);

    assert!(claimed.is_err());
    assert!(!a.store.knows_shared(doc, attachment).unwrap());
    assert!(a.store.erase_shared(space, doc, attachment).is_err());
    assert!(a.keeps_copy(attachment));
    assert!(a.store.erased_files(space).unwrap().is_empty());
}

#[test]
fn a_listed_version_is_erased_only_after_this_device_has_verified_it() {
    let mut a = Device::page();

    a.writes("Stand vor der Bearbeitung", &[], false);
    a.store.keep_version(a.note.id, None, Some("file")).unwrap();
    let record = a.store.unshared_versions(a.note.space, a.note.id).unwrap();
    let record = record[0].1.clone();
    let file = a.shares()[0];
    let (space, doc) = (a.note.space, a.note.id);
    let mut b = device(space, doc, "page");

    b.writes("Neuer Stand", &[file], true);
    assert!(b.store.erase_shared(space, doc, file).is_err());
    assert!(b.store.erased_files(space).unwrap().is_empty());
    b.store.shared_version(space, doc, file, &record).unwrap();
    assert!(b.store.knows_shared(doc, file).unwrap());
    b.store.erase_shared(space, doc, file).unwrap();
    assert_eq!(b.store.erased_files(space).unwrap(), vec![file]);
    assert!(!b.store.knows_shared(doc, file).unwrap());
}

#[test]
fn chats_and_the_workspace_share_nothing() {
    let space = Uuid::new_v4();
    let mut chat = device(space, Uuid::new_v4(), "chat");

    chat.writes("Frage", &[], false);
    chat.store
        .keep_version(chat.note.id, Some("Chat"), None)
        .unwrap();
    assert!(chat.shares().is_empty());
    assert_eq!(chat.reconciles(), (vec![], vec![]));
}

fn restored_from(a: &Device) -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(&dir.path().join("restored"), &[6; 32]).unwrap();
    let space = a.note.space;
    let bundle = a.store.backup_bundle(space, a.note.id).unwrap();

    assert!(bundle.missing.is_empty());
    store.begin_restore(space).unwrap();
    store.restore_records(space, bundle.records).unwrap();

    (dir, store)
}

fn sorted(mut files: Vec<Uuid>) -> Vec<Uuid> {
    files.sort();

    files
}

#[test]
fn a_backup_keeps_causes_and_which_versions_were_shared() {
    let mut a = Device::page();

    a.writes("Stand", &[], false);
    a.store.keep_version(a.note.id, None, Some("ai")).unwrap();
    a.writes("Zweiter Stand", &[], false);
    a.store
        .keep_version(a.note.id, Some("Vor Umbau"), None)
        .unwrap();
    let files = a.shares();

    a.writes("Zweiter Stand", &files, false);
    let (own, _) = a.reconciles();
    let (_dir, mut restored) = restored_from(&a);
    let (space, doc) = (a.note.space, a.note.id);

    assert_eq!(
        restored.versions(doc).unwrap(),
        a.store.versions(doc).unwrap()
    );
    assert!(restored.unshared_versions(space, doc).unwrap().is_empty());
    let shares = restored.reconcile_shared(space, doc).unwrap();
    let kept = shares.own.into_iter().map(|v| v.file).collect();

    assert_eq!(sorted(kept), sorted(own));
    assert!(shares.gone.is_empty());
}

#[test]
fn a_backup_refuses_unknown_causes_and_foreign_shares() {
    use kladde_store::Record;

    let mut a = Device::page();

    a.writes("Stand", &[], false);
    let rev = a.store.keep_version(a.note.id, None, Some("ai")).unwrap();
    let (space, id) = (a.note.space, a.note.id);
    let hostile = [
        Record::Cause {
            id,
            rev,
            cause: "beliebig".into(),
            origin: None,
        },
        Record::Cause {
            id,
            rev,
            cause: "ai".into(),
            origin: Some("fremd".into()),
        },
        Record::Cause {
            id,
            rev: rev + 50,
            cause: "ai".into(),
            origin: None,
        },
        Record::Shared {
            id,
            file: Uuid::new_v4(),
            rev: Some(rev),
            state: 7,
        },
        Record::Shared {
            id,
            file: Uuid::nil(),
            rev: Some(rev),
            state: 1,
        },
        Record::Shared {
            id: Uuid::new_v4(),
            file: Uuid::new_v4(),
            rev: None,
            state: 1,
        },
    ];

    for record in hostile {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("restored"), &[7; 32]).unwrap();

        store.begin_restore(space).unwrap();
        let mut records = a.store.backup_bundle(space, id).unwrap().records;

        records.retain(|record| !matches!(record, Record::Cause { .. }));
        records.push(record);
        assert!(store.restore_records(space, records).is_err());
        assert!(store.get(id).unwrap().is_none());
    }
}
