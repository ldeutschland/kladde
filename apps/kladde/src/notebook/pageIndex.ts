import * as Y from "yjs";
import type { Entry, Page, StoredState } from "./notebook";

type PageMap = Y.Map<Page>;
type StampMap = Y.Map<number>;
type Registry = Y.Map<string>;
type Load = (id: string) => Promise<StoredState | null>;

interface Home {
  owner: string;
  bucket: number;
}
interface Shard extends Home {
  entry: Entry;
}

export interface IndexHost {
  id: string;
  manifest: Entry;
  watch: (entry: Entry) => void;
  release: (id: string) => void;
  notify: () => void;
}

const LOAD_BATCH = 32;
const LEGACY_RANK = "~";

export function bucketOf(id: string) {
  const bucket = Number.parseInt(id.slice(0, 2), 16);

  return Number.isNaN(bucket) ? 0 : bucket;
}

function collect<K, V>(groups: Map<K, V[]>, key: K, value: V) {
  const group = groups.get(key) ?? [];

  group.push(value);
  groups.set(key, group);
}

function homeKey(home: Home) {
  return home.owner + "/" + home.bucket;
}

function parseHome(text: string): Home | null {
  const cut = text.lastIndexOf("/");
  const bucket = Number(text.slice(cut + 1));

  if (cut < 1 || !Number.isInteger(bucket) || bucket < 0 || bucket > 255)
    return null;

  return { owner: text.slice(0, cut), bucket };
}

export class Pages implements Iterable<[string, Page]> {
  settled = false;
  version = 0;
  private live = false;
  private known = new Map<string, Page>();
  private holders = new Map<string, Set<PageMap>>();
  private stamps = new Map<string, number>();
  private shards = new Map<PageMap, Shard>();
  private attached = new Set<string>();
  private byHome = new Map<string, Shard[]>();
  private pending = new Map<string, Home>();
  private erased = new Set<string>();
  private absent = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private legacy: PageMap;

  constructor(
    private host: IndexHost,
    private load: Load,
  ) {
    const doc = host.manifest.doc;

    this.legacy = doc.getMap<Page>("pages");
    this.observePages(this.legacy);
    this.observeStamps(doc.getMap<number>("edits"));
    this.observeRegistry(doc.getMap<string>("index"));
  }

  get size() {
    return this.known.size;
  }
  get(id: string) {
    return this.known.get(id);
  }
  has(id: string) {
    return this.known.has(id);
  }
  values() {
    return this.known.values();
  }
  keys() {
    return this.known.keys();
  }
  entries() {
    return this.known.entries();
  }
  [Symbol.iterator]() {
    return this.known.entries();
  }

  editedAt(page: Page) {
    return Math.max(page.updated, this.stamps.get(page.id) ?? 0);
  }

  set(id: string, page: Page, origin?: unknown) {
    this.setAll([page.id === id ? page : { ...page, id }], origin);
  }

  setAll(pages: Page[], origin?: unknown) {
    const writes = new Map<PageMap, Page[]>();
    const stale = new Map<PageMap, string[]>();

    for (const page of pages) {
      this.erased.delete(page.id);
      const target = this.mapFor(page);

      collect(writes, target, page);
      for (const map of this.holders.get(page.id) ?? [])
        if (map !== target) collect(stale, map, page.id);
    }

    for (const [map, group] of writes)
      map.doc?.transact(() => group.forEach((p) => map.set(p.id, p)), origin);
    for (const [map, ids] of stale)
      map.doc?.transact(() => ids.forEach((id) => map.delete(id)), origin);
  }

  delete(id: string, origin?: unknown) {
    this.deleteAll([id], origin);
  }

  deleteAll(ids: string[], origin?: unknown) {
    const doomed = new Map<PageMap, string[]>();

    for (const id of ids) {
      if (this.pending.size) this.erased.add(id);
      for (const map of this.holders.get(id) ?? []) collect(doomed, map, id);
    }

    for (const [map, group] of doomed) {
      const stamps = map.doc?.getMap<number>("edits");

      map.doc?.transact(() => {
        for (const id of group) {
          map.delete(id);
          stamps?.delete(id);
        }
      }, origin);
    }
  }

  forgetOwner(owner: string) {
    for (const shard of [...this.shards.values()])
      if (shard.owner === owner) this.registry(owner).delete(shard.entry.id);
  }

  private detach(id: string) {
    this.pending.delete(id);
    this.absent.delete(id);
    const found = [...this.shards].find(([, shard]) => shard.entry.id === id);

    if (!found) return;
    const [pages, shard] = found;
    const shelf = this.byHome.get(homeKey(shard)) ?? [];

    this.byHome.set(
      homeKey(shard),
      shelf.filter((other) => other !== shard),
    );
    this.shards.delete(pages);
    this.attached.delete(id);
    for (const page of [...pages.keys()]) this.hold(page, pages);
    this.host.release(id);
  }

  touch(id: string, at: number, origin?: unknown) {
    const home = this.ranked(this.holders.get(id))[0] ?? this.legacy;
    const stamps = home.doc?.getMap<number>("edits");

    stamps?.doc?.transact(() => stamps.set(id, at), origin);
  }

  mapsFor(page: Page) {
    return [this.mapFor(page), ...(this.holders.get(page.id) ?? [])];
  }

  async open() {
    await this.fetchAll((home) => home.owner === this.host.id);
    this.settled = this.legacy.size === 0;
    this.live = true;
    void this.whole().then(() => {
      if (this.settled) void this.settle();
    });
  }

  async whole() {
    while (this.waitingIds(() => true).length) await this.fetchAll(() => true);
  }

  async rowsOf(owner: string) {
    await this.fetchAll((home) => home.owner === owner);
  }

  async adopt(id: string) {
    if (!this.pending.has(id)) return;
    this.absent.delete(id);
    await this.fetch(id);
  }

  async settle() {
    await this.whole();
    this.settled = true;
    const copied = this.legacyPages((page) => this.inShard(page.id));
    const moves = new Map<PageMap, Page[]>();

    for (const page of this.legacyPages((page) => !this.inShard(page.id))) {
      const target = this.mapFor(page);

      if (target === this.legacy) continue;
      moves.set(target, [...(moves.get(target) ?? []), page]);
    }

    for (const [target, moved] of moves)
      target.doc?.transact(() => moved.forEach((p) => target.set(p.id, p)));
    for (const page of copied)
      if (this.known.get(page.id) === page) this.set(page.id, page);
    this.legacy.doc?.transact(() =>
      copied.forEach((p) => this.legacy.delete(p.id)),
    );
    this.moveStamps();
  }

  private legacyPages(wanted: (page: Page) => boolean) {
    return [...this.legacy.values()].filter(wanted);
  }

  private inShard(id: string) {
    for (const map of this.holders.get(id) ?? [])
      if (map !== this.legacy) return true;

    return false;
  }

  private moveStamps() {
    const stamps = this.host.manifest.doc.getMap<number>("edits");

    for (const [id, at] of [...stamps.entries()]) {
      if (this.legacy.has(id)) continue;
      if (this.known.has(id)) this.touch(id, at);
      stamps.delete(id);
    }
  }

  private ownerOf(page: Page) {
    return page.kind === "row" && page.parent ? page.parent : this.host.id;
  }

  private mapFor(page: Page): PageMap {
    const shards = this.ranked(this.holders.get(page.id));
    const held = shards.find((map) => map !== this.legacy);

    if (!this.settled) return held ?? this.legacy;
    const home = { owner: this.ownerOf(page), bucket: bucketOf(page.id) };

    if (this.awaits(home)) return held ?? this.legacy;

    return this.shardFor(home).entry.doc.getMap<Page>("pages");
  }

  private awaits(home: Home) {
    const key = homeKey(home);

    for (const waiting of this.pending.values())
      if (homeKey(waiting) === key) return true;

    return false;
  }

  private registry(owner: string): Registry {
    if (owner === this.host.id)
      return this.host.manifest.doc.getMap<string>("index");
    const shelf = this.shardFor({
      owner: this.host.id,
      bucket: bucketOf(owner),
    });

    return shelf.entry.doc.getMap<string>("index");
  }

  private shardFor(home: Home) {
    const existing = this.byHome.get(homeKey(home))?.[0];

    if (existing) return existing;
    const id = crypto.randomUUID();
    const entry: Entry = {
      id,
      doc: new Y.Doc(),
      rev: 0,
      kind: "index",
      owner: home.owner,
    };
    const shard = this.attach(entry, home);

    this.registry(home.owner).set(id, homeKey(home));

    return shard;
  }

  private attach(entry: Entry, home: Home) {
    const shard = { ...home, entry };
    const pages = entry.doc.getMap<Page>("pages");
    const key = homeKey(home);
    const shelf = [...(this.byHome.get(key) ?? []), shard];

    shelf.sort((a, b) => a.entry.id.localeCompare(b.entry.id));
    this.byHome.set(key, shelf);
    this.shards.set(pages, shard);
    this.attached.add(entry.id);
    this.host.watch(entry);
    this.observePages(pages);
    this.observeStamps(entry.doc.getMap<number>("edits"));
    if (home.owner === this.host.id)
      this.observeRegistry(entry.doc.getMap<string>("index"));

    return shard;
  }

  private forget(pages: PageMap) {
    const stale = [...this.erased].filter((id) => pages.has(id));

    if (stale.length)
      pages.doc?.transact(() => stale.forEach((id) => pages.delete(id)));
    if (!this.pending.size) this.erased.clear();
  }

  private rank(map: PageMap) {
    return this.shards.get(map)?.entry.id ?? LEGACY_RANK;
  }

  private ranked(maps: Iterable<PageMap> = []) {
    return [...maps].sort((a, b) => this.rank(a).localeCompare(this.rank(b)));
  }

  private observePages(map: PageMap) {
    for (const id of map.keys()) this.hold(id, map);
    map.observe((event) => {
      for (const id of event.keysChanged) this.hold(id, map);
    });
  }

  private hold(id: string, map: PageMap) {
    const holders = this.holders.get(id) ?? new Set<PageMap>();
    const kept = map === this.legacy || this.shards.has(map);

    if (kept && map.has(id)) holders.add(map);
    else holders.delete(map);
    if (holders.size) this.holders.set(id, holders);
    else this.holders.delete(id);
    this.resolve(id, holders);
    this.stamp(id);
  }

  private resolve(id: string, holders: Set<PageMap>) {
    let best: Page | undefined;

    for (const map of this.ranked(holders)) {
      const page = map.get(id);

      if (page && (!best || page.updated > best.updated)) best = page;
    }

    if (best) this.known.set(id, best);
    else this.known.delete(id);
    this.version++;
  }

  private observeStamps(map: StampMap) {
    for (const id of map.keys()) this.stamp(id);
    map.observe((event) => {
      for (const id of event.keysChanged) this.stamp(id);
    });
  }

  private stamp(id: string) {
    const docs = [...(this.holders.get(id) ?? [])].map((map) => map.doc);
    const stamped = [this.legacy.doc, ...docs].map(
      (doc) => doc?.getMap<number>("edits").get(id) ?? 0,
    );
    const latest = Math.max(...stamped);

    if (latest) this.stamps.set(id, latest);
    else this.stamps.delete(id);
    this.version++;
  }

  private observeRegistry(map: Registry) {
    for (const [id, home] of map) this.register(id, home);
    map.observe((event) => {
      for (const id of event.keysChanged)
        if (map.has(id)) this.register(id, map.get(id));
        else this.detach(id);
    });
  }

  private register(id: string, text: string | undefined) {
    const home = text ? parseHome(text) : null;

    if (!home || this.pending.has(id) || this.attached.has(id)) return;
    this.pending.set(id, home);
    if (this.live) void this.fetch(id);
  }

  private waitingIds(wanted: (home: Home) => boolean) {
    return [...this.pending]
      .filter(([id, home]) => !this.absent.has(id) && wanted(home))
      .map(([id]) => id);
  }

  private async fetchAll(wanted: (home: Home) => boolean) {
    const ids = this.waitingIds(wanted);

    for (let from = 0; from < ids.length; from += LOAD_BATCH)
      await Promise.all(
        ids.slice(from, from + LOAD_BATCH).map((id) => this.fetch(id)),
      );
  }

  private fetch(id: string) {
    const running = this.loading.get(id);

    if (running) return running;
    const task = this.pull(id).finally(() => this.loading.delete(id));

    this.loading.set(id, task);

    return task;
  }

  private async pull(id: string) {
    const state = await this.load(id).catch(() => null);
    const home = this.pending.get(id);

    if (!home) return;

    if (!state?.data) {
      this.absent.add(id);

      return;
    }

    this.pending.delete(id);
    const doc = new Y.Doc();

    Y.applyUpdate(doc, state.data);
    const owner = home.owner;
    const shard = this.attach(
      { id, doc, rev: state.rev, kind: "index", owner },
      home,
    );

    this.forget(shard.entry.doc.getMap<Page>("pages"));
    this.host.notify();
  }
}
