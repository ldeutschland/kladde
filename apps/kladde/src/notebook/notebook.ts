import * as Y from "yjs";
import { applyAutomations } from "../database/rules";
import { pagesLinkedIn } from "./links";
import { command } from "../platform/native";
import { Pages } from "./pageIndex";

export type Kind = "workspace" | "page" | "database" | "row" | "chat" | "index";
export interface Page {
  id: string;
  title: string;
  kind: Kind;
  parent: string | null;
  order: number;
  created?: number;
  icon: string;
  favorite: boolean;
  archived: number | null;
  updated: number;
  cover: string;
  wide: boolean;
  ai?: string;
  aiExcluded?: boolean;
  rescued?: string;
}
export interface Stored {
  id: string;
  space: string;
  kind: Kind;
  title: string;
  body: string;
  parent: string | null;
  archived: boolean;
  props: string;
  links: string[];
  data: number[];
  rev: number;
}
export interface Entry {
  id: string;
  doc: Y.Doc;
  rev: number;
  kind: Kind;
  owner?: string;
}
export interface StoredState {
  rev: number;
  data: Uint8Array | null;
}
const REV_BYTES = 8;

function readState(buffer: ArrayBuffer): StoredState | null {
  if (buffer.byteLength === 0) return null;
  if (buffer.byteLength < REV_BYTES) throw Error("Invalid document state");
  const rev = Number(new DataView(buffer).getBigInt64(0, true));

  if (!Number.isSafeInteger(rev) || rev < 1)
    throw Error("Invalid document revision");
  const data =
    buffer.byteLength > REV_BYTES ? new Uint8Array(buffer, REV_BYTES) : null;

  return { rev, data };
}

export async function loadState(
  id: string,
  space: string,
  kind: Kind,
  after: number,
) {
  const buffer = await command<ArrayBuffer>("load_state", {
    id,
    space,
    kind,
    after,
  });

  return readState(buffer);
}
export function freshPage(
  id: string,
  title: string,
  kind: Kind,
  parent: string | null,
): Page {
  const now = Date.now();

  return {
    id,
    title,
    kind,
    parent,
    order: now,
    created: now,
    icon: "",
    favorite: false,
    archived: null,
    updated: now,
    cover: "",
    wide: false,
  };
}
export function createdAt(page: Page) {
  return page.created ?? page.order;
}
export function unpack(data: number[]) {
  const doc = new Y.Doc();

  Y.applyUpdate(doc, Uint8Array.from(data));

  return doc;
}

type PageLookup = { get: (id: string) => Page | undefined };

export function mayMove(pages: PageLookup, id: string, parent: string | null) {
  const seen = new Set([id]);
  let target = true;

  while (parent) {
    if (seen.has(parent)) return false;
    seen.add(parent);
    const p = pages.get(parent);

    if (!p || p.archived) return !target;
    target = false;
    parent = p.parent;
  }

  return true;
}

function startsCycle(pages: PageLookup, page: Page) {
  let smallest = page.id;
  const seen = new Set([page.id]);
  let at = page.parent ? pages.get(page.parent) : undefined;

  while (at) {
    if (at.id === page.id) return smallest === page.id;
    if (seen.has(at.id)) return false;
    seen.add(at.id);
    if (at.id < smallest) smallest = at.id;
    at = at.parent ? pages.get(at.parent) : undefined;
  }

  return false;
}

export function treeParent(pages: PageLookup, page: Page) {
  const parent = page.parent ? pages.get(page.parent) : undefined;

  if (!parent || parent.archived || startsCycle(pages, page)) return null;

  return parent.id;
}

export const MAX_TITLE = 200;
const TEXT_EDIT_INTERVAL_MS = 5000;
const MODIFIED = "Notebook was modified";
const REFUSED = "Invalid notebook data";

export class Notebook {
  entries = new Map<string, Entry>();
  private rowChanges = new Map<string, Set<string>>();
  dirty = new Set<string>();
  listeners = new Set<() => void>();
  tick = 0;
  saves = 0;
  error = "";
  busy = false;
  onSaved?: (entries: Entry[]) => void;
  onArrived?: (entry: Entry) => void;
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly pages: Pages;
  constructor(
    public id: string,
    public manifest: Entry,
  ) {
    this.watch(manifest);
    this.pages = new Pages(this, (shard) => loadState(shard, id, "index", 0));
  }
  static async openManifest(id: string) {
    const buffer = await command<ArrayBuffer>("load_manifest", { id });
    const state = readState(buffer);

    if (!state?.data) throw Error("Invalid notebook");
    const doc = new Y.Doc();

    Y.applyUpdate(doc, state.data);

    return new Notebook(id, { id, kind: "workspace", doc, rev: state.rev });
  }
  static async open(id: string) {
    const book = await Notebook.openManifest(id);

    await book.pages.open();
    const account = await command("account_info", { space: id }).catch(() => 1);

    if (!account) await book.pages.settle();

    return book;
  }
  static async create(title: string) {
    const id = crypto.randomUUID();
    const doc = new Y.Doc();
    const book = new Notebook(id, { id, doc, kind: "workspace", rev: 0 });

    book.pages.settled = true;
    book.rename(title);
    await book.flush();

    return book;
  }
  get title() {
    return String(this.manifest.doc.getMap("meta").get("title") ?? "");
  }
  rename(title: string) {
    this.manifest.doc.getMap("meta").set("title", title.slice(0, MAX_TITLE));
  }
  get settings() {
    return this.manifest.doc.getMap<unknown>("settings");
  }
  editedAt(page: Page) {
    return this.pages.editedAt(page);
  }
  dated(id: string): Page | undefined {
    const page = this.pages.get(id);

    return page && { ...page, updated: this.editedAt(page) };
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);

    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.tick;
  notify() {
    this.tick++;
    for (const fn of this.listeners) fn();
  }
  watch(e: Entry) {
    this.entries.set(e.id, e);
    e.doc.getMap("meta").observe((event, transaction) => {
      const change = event.changes.keys.get("text");

      if (!change || transaction.origin === "remote") return;
      if ((change.oldValue ?? "") !== e.doc.getMap("meta").get("text"))
        this.markEdited(e.id, TEXT_EDIT_INTERVAL_MS, transaction.origin);
    });

    if (e.kind === "row") {
      e.doc.getMap("properties").observe((event, transaction) => {
        if (transaction.origin === "remote") return;
        this.markEdited(e.id, 0, transaction.origin);
        if (transaction.origin != null) return;
        const changed = this.rowChanges.get(e.id) ?? new Set<string>();

        for (const key of event.keysChanged) changed.add(key);
        this.rowChanges.set(e.id, changed);
      });
    }

    e.doc.on("update", (_update: Uint8Array, origin: unknown) => {
      if (origin === "remote") {
        this.onArrived?.(e);
        this.notify();

        return;
      }

      this.dirty.add(e.id);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.flush().catch(() => {});
      }, 90);
      this.notify();
    });
  }
  private markEdited(id: string, interval: number, origin: unknown) {
    const page = this.pages.get(id);
    const now = Date.now();

    if (!page || now - this.editedAt(page) < interval) return;
    this.pages.touch(id, now, origin);
  }
  async load(id: string) {
    const current = this.entries.get(id);

    if (current) return current;
    const n = await command<Stored | null>("load", { id });

    if (!n || n.space !== this.id) throw Error("Document unavailable");
    const existing = this.entries.get(id);

    if (existing) return existing;
    const e = { id, doc: unpack(n.data), rev: n.rev, kind: n.kind };

    this.watch(e);
    if (n.kind === "row" && n.parent) await this.pages.rowsOf(n.parent);
    this.onArrived?.(e);

    return e;
  }
  add(
    title: string,
    kind: Kind = "page",
    parent: string | null = null,
    id: string = crypto.randomUUID(),
  ) {
    if (!mayMove(this.pages, id, parent) || this.pages.has(id))
      throw Error("Invalid parent or ID");
    const page = freshPage(id, title.slice(0, MAX_TITLE), kind, parent);
    const e = { id, doc: new Y.Doc(), rev: 0, kind };

    this.watch(e);
    if (kind === "row") this.rowChanges.set(id, new Set());
    e.doc.getMap("meta").set("title", page.title);
    this.pages.set(id, page);

    return e;
  }
  async change(
    id: string,
    patch: Partial<
      Pick<
        Page,
        | "title"
        | "icon"
        | "parent"
        | "order"
        | "favorite"
        | "archived"
        | "wide"
        | "cover"
        | "ai"
        | "aiExcluded"
      >
    >,
  ) {
    const e = this.entries.get(id) ?? (await this.load(id));
    const page = this.pages.get(id);

    if (!page) throw Error("Document unavailable");
    if (patch.parent !== undefined && !mayMove(this.pages, id, patch.parent))
      throw Error("Invalid parent");
    const next = { ...page, ...patch, updated: Date.now() };

    this.pages.set(id, next);
    e.doc.getMap("meta").set("title", next.title);
    this.dirty.add(id);
  }
  branch(id: string) {
    const root = this.pages.get(id);

    if (!root) return [];
    const children = new Map<string, string[]>();

    for (const p of this.pages.values()) {
      if (!p.parent || p.archived !== root.archived) continue;
      const list = children.get(p.parent) ?? [];

      list.push(p.id);
      children.set(p.parent, list);
    }

    const pending = [id],
      seen = new Set<string>();

    for (let i = 0; i < pending.length; i++) {
      const target = pending[i];

      if (seen.has(target)) continue;
      seen.add(target);
      pending.push(...(children.get(target) ?? []));
    }

    return [...seen];
  }
  release(id: string) {
    this.entries.delete(id);
    this.dirty.delete(id);
  }
  discardUnsaved(id: string) {
    if (this.entries.get(id)?.rev) throw Error("Document already saved");
    this.unlist([id]);
  }
  private ownedRows(pages: Page[]) {
    const databases = new Set(
      pages.filter((p) => p.kind === "database").map((p) => p.id),
    );
    const owned = pages.filter(
      (p) => p.kind === "row" && databases.has(p.parent ?? ""),
    );

    return new Set(owned.map((p) => p.id));
  }
  async trashBranch(id: string, archived: number | null) {
    await this.pages.whole();
    const branch = this.branch(id).flatMap((t) => this.pages.get(t) ?? []);
    const rows = this.ownedRows(branch);
    const updated = Date.now();

    this.pages.setAll(
      branch
        .filter((p) => rows.has(p.id))
        .map((p) => ({ ...p, archived, updated })),
    );
    for (const page of branch)
      if (!rows.has(page.id)) await this.change(page.id, { archived });
    await this.flush();
  }
  record(e: Entry): Stored {
    const meta = e.doc.getMap("meta"),
      p = this.pages.get(e.id),
      listed = e.kind === "workspace" || e.kind === "index",
      body = String(meta.get("text") ?? "");
    const links = pagesLinkedIn(body);

    return {
      id: e.id,
      space: this.id,
      kind: e.kind,
      title: p?.title ?? String(meta.get("title") ?? ""),
      parent: e.kind === "index" ? (e.owner ?? null) : (p?.parent ?? null),
      archived: !listed && (!p || !!p.archived),
      body,
      links,
      props: JSON.stringify(e.doc.getMap("properties").toJSON()),
      data: Array.from(Y.encodeStateAsUpdate(e.doc)),
      rev: e.rev,
    };
  }
  private unlist(ids: string[]) {
    this.pages.deleteAll(ids);

    for (const id of ids) {
      this.release(id);
      this.rowChanges.delete(id);
    }
  }
  private async detach(ids: string[]) {
    const leaving = new Set(ids);

    for (const page of [...this.pages.values()])
      if (page.parent && leaving.has(page.parent) && !leaving.has(page.id))
        await this.change(page.id, { parent: null });
  }
  private async removeAll(
    ids: string[],
    kept: Map<string, Page>,
    remove: (id: string) => Promise<unknown>,
  ) {
    const rows = this.ownedRows([...kept.values()]);
    const erased = new Set<string>();

    try {
      for (const id of [...ids].reverse()) {
        if (rows.has(id)) continue;
        await remove(id);
        erased.add(id);
        if (kept.get(id)?.kind === "database") this.pages.forgetOwner(id);
      }
    } catch (error) {
      const gone = (p: Page) =>
        erased.has(p.id) || (rows.has(p.id) && erased.has(p.parent ?? ""));

      this.pages.setAll([...kept.values()].filter((p) => !gone(p)));
      await this.flush();
      throw error;
    }
  }
  async erase(ids: string[], remove: (id: string) => Promise<unknown>) {
    await this.pages.whole();
    const listed = ids.flatMap((id) => this.pages.get(id) ?? []);
    const kept = new Map(listed.map((page) => [page.id, page]));

    await this.detach(ids);
    await this.flush();
    this.unlist(ids);
    await this.flush();
    await this.removeAll(ids, kept, remove);
    await this.flush();
  }
  private take() {
    const ids = [...this.dirty].slice(0, 1000);

    for (const id of ids) this.dirty.delete(id);

    return ids.flatMap((id) => this.entries.get(id) ?? []);
  }
  private async automate(entries: Entry[]) {
    for (const entry of entries) {
      const changed = this.rowChanges.get(entry.id);
      const page = this.pages.get(entry.id);

      if (!changed || !page?.parent || page.archived) continue;
      const db = await this.load(page.parent).catch(() => null);

      this.rowChanges.delete(entry.id);
      if (db?.kind !== "database") continue;
      const event = entry.rev ? "change" : "create";

      applyAutomations(this, db, entry, page.title, event, changed);
    }
  }
  private async save(entries: Entry[], unsaved: Set<Entry>) {
    if (!entries.length) return;
    await command("save", { notes: entries.map((e) => this.record(e)) });

    for (const entry of entries) {
      entry.rev++;
      unsaved.delete(entry);
    }
  }
  private async latest(entry: Entry) {
    const state = await loadState(entry.id, this.id, entry.kind, entry.rev);

    if (!state || state.data || state.rev >= entry.rev) return state;

    return loadState(entry.id, this.id, entry.kind, 0);
  }
  private async caughtUp(entries: Entry[]) {
    const current: Entry[] = [];

    for (const entry of entries) {
      const state = await this.latest(entry);

      if (!state && entry.rev > 0) {
        this.entries.delete(entry.id);
        continue;
      }

      if (state?.data) Y.applyUpdate(entry.doc, state.data, "remote");
      if (state) entry.rev = state.rev;
      current.push(entry);
    }

    return current;
  }
  private async saveEach(
    entries: Entry[],
    unsaved: Set<Entry>,
    refused: Set<Entry>,
  ) {
    const failures: unknown[] = [];

    for (const entry of entries)
      await this.save([entry], unsaved).catch((error) => {
        if (String(error).includes(REFUSED)) refused.add(entry);
        failures.push(error);
      });
    if (failures.length) throw failures[0];
  }
  private async store(
    entries: Entry[],
    unsaved: Set<Entry>,
    refused: Set<Entry>,
  ) {
    try {
      return await this.save(entries, unsaved);
    } catch (error) {
      if (!String(error).includes(MODIFIED))
        return this.saveEach(entries, unsaved, refused);
    }

    const current = await this.caughtUp(entries);

    try {
      await this.save(current, unsaved);
    } catch {
      await this.saveEach(current, unsaved, refused);
    }
  }
  private requeue(unsaved: Set<Entry>, refused: Set<Entry>) {
    for (const entry of unsaved)
      if (this.entries.get(entry.id) === entry && !refused.has(entry))
        this.dirty.add(entry.id);
  }
  private async write(): Promise<void> {
    const entries = this.take();

    if (!entries.length) return;
    const unsaved = new Set(entries);
    const refused = new Set<Entry>();

    this.busy = true;
    this.notify();

    try {
      await this.automate(entries);
      await this.store(entries, unsaved, refused);
      this.onSaved?.(entries.filter((entry) => !unsaved.has(entry)));
      this.saves++;
      this.error = "";
    } catch (error) {
      this.requeue(unsaved, refused);
      this.error = String(error);
      throw error;
    } finally {
      this.busy = false;
      this.notify();
    }

    if (this.dirty.size) await this.write();
  }
  flush() {
    clearTimeout(this.timer);
    this.queue = this.queue.catch(() => {}).then(() => this.write());

    return this.queue;
  }
}
