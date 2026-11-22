import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Page, Stored } from "../../src/notebook/notebook";

const native = vi.hoisted(() => ({
  notes: new Map<
    string,
    { kind: string; parent: string | null; rev: number; data: number[] }
  >(),
  account: null as string[] | null,
}));

function stamped(rev: number, data: number[]) {
  const bytes = new Uint8Array(8 + data.length);

  new DataView(bytes.buffer).setBigInt64(0, BigInt(rev), true);
  bytes.set(data, 8);

  return bytes.buffer;
}

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "account_info") return native.account;

    if (name === "save") {
      for (const note of args.notes as Stored[]) {
        if ((native.notes.get(note.id)?.rev ?? 0) !== note.rev)
          throw Error("Notebook was modified");
        native.notes.set(note.id, { ...note, rev: note.rev + 1 });
      }

      return undefined;
    }

    const note = native.notes.get(String(args.id));

    if (name === "load") return note ? { ...note, id: args.id } : null;
    if (!note || (name === "load_state" && note.kind !== args.kind))
      return new ArrayBuffer(0);

    return stamped(
      note.rev,
      note.rev > Number(args.after ?? 0) ? note.data : [],
    );
  }),
}));

const { Notebook, freshPage } = await import("../../src/notebook/notebook");

const SPACE = "11111111-1111-4111-8111-111111111111";

function storeOldManifest(pages: Page[]) {
  const doc = new Y.Doc();

  doc.getMap("meta").set("title", "Alt");
  for (const page of pages) doc.getMap<Page>("pages").set(page.id, page);
  const data = Array.from(Y.encodeStateAsUpdate(doc));

  native.notes.set(SPACE, { kind: "workspace", parent: null, rev: 1, data });
}

function manifestPages(book: InstanceType<typeof Notebook>) {
  return book.manifest.doc.getMap<Page>("pages");
}

function directories() {
  return [...native.notes.values()].filter((note) => note.kind === "index");
}

beforeEach(() => {
  native.notes = new Map();
  native.account = null;
});

describe("page directory", () => {
  it("keeps new pages out of the manifest and rows with their database", async () => {
    const book = await Notebook.create("Notizbuch");
    const page = book.add("Seite");
    const database = book.add("Datenbank", "database");
    const row = book.add("Zeile", "row", database.id);

    await book.flush();
    expect(manifestPages(book).size).toBe(0);
    expect(book.pages.get(page.id)?.title).toBe("Seite");
    expect(book.pages.size).toBe(3);
    const owners = directories().map((note) => note.parent);

    expect(owners).toContain(book.id);
    expect(owners).toContain(database.id);
    expect(book.pages.get(row.id)?.parent).toBe(database.id);
  });

  it("opens a notebook again from its directory documents", async () => {
    const created = await Notebook.create("Notizbuch");
    const database = created.add("Datenbank", "database");
    const rows = Array.from({ length: 40 }, (_, n) =>
      created.add("Zeile " + n, "row", database.id),
    );

    await created.flush();
    const book = await Notebook.open(created.id);

    expect(book.pages.get(database.id)?.kind).toBe("database");
    await book.pages.whole();
    expect(book.pages.size).toBe(41);
    expect(book.pages.get(rows[7].id)?.title).toBe("Zeile 7");
  });

  it("moves an old manifest into the directory in two passes", async () => {
    const parent = freshPage(crypto.randomUUID(), "Eltern", "page", null);
    const child = freshPage(crypto.randomUUID(), "Kind", "page", parent.id);

    storeOldManifest([parent, child]);
    const first = await Notebook.open(SPACE);

    expect(first.pages.get(child.id)?.parent).toBe(parent.id);
    expect(manifestPages(first).size).toBe(2);
    await first.flush();
    expect(directories().length).toBeGreaterThan(0);
    const second = await Notebook.open(SPACE);

    await second.flush();
    expect(manifestPages(second).size).toBe(0);
    expect(second.pages.size).toBe(2);
    expect(second.pages.get(child.id)?.title).toBe("Kind");
  });

  it("waits for the first full sync before moving a connected notebook", async () => {
    const page = freshPage(crypto.randomUUID(), "Seite", "page", null);

    storeOldManifest([page]);
    native.account = ["https://sync.example.org", "test", SPACE, "device"];
    const book = await Notebook.open(SPACE);
    const added = book.add("neu");

    expect(manifestPages(book).has(added.id)).toBe(true);
    await book.flush();
    expect(directories()).toEqual([]);
    await book.pages.settle();
    await book.flush();
    expect(directories().length).toBeGreaterThan(0);
    const renamed = { ...book.pages.get(page.id)!, title: "umbenannt" };

    book.pages.set(page.id, renamed);
    expect(manifestPages(book).has(page.id)).toBe(false);
    expect(book.pages.get(page.id)?.title).toBe("umbenannt");
  });

  it("keeps a newer manifest entry and a deletion made before a directory loaded", async () => {
    const created = await Notebook.create("Notizbuch");
    const kept = created.add("alt");
    const doomed = created.add("weg");

    await created.flush();
    const old = created.pages.get(kept.id)!;
    const newer = {
      ...old,
      title: "offline umbenannt",
      updated: old.updated + 1,
    };

    manifestPages(created).set(kept.id, newer);
    await created.flush();
    native.account = ["https://sync.example.org", "test", created.id, "device"];
    const book = await Notebook.open(created.id);

    expect(book.pages.get(kept.id)?.title).toBe("offline umbenannt");
    await book.pages.settle();
    expect(manifestPages(book).has(kept.id)).toBe(false);
    expect(book.pages.get(kept.id)?.title).toBe("offline umbenannt");
    book.pages.delete(doomed.id);
    await book.flush();
    const again = await Notebook.open(created.id);

    await again.pages.whole();
    expect(again.pages.has(doomed.id)).toBe(false);
    expect(again.pages.get(kept.id)?.title).toBe("offline umbenannt");
  });

  it("drops the rows of a database whose directories are unregistered", async () => {
    const book = await Notebook.create("Notizbuch");
    const database = book.add("Datenbank", "database");
    const rows = Array.from({ length: 20 }, (_, n) =>
      book.add("Zeile " + n, "row", database.id),
    );

    await book.flush();
    expect(book.pages.has(rows[3].id)).toBe(true);
    book.pages.forgetOwner(database.id);
    expect(book.pages.has(rows[3].id)).toBe(false);
    expect(book.pages.has(database.id)).toBe(true);
    await book.flush();
    const again = await Notebook.open(book.id);

    await again.pages.whole();
    expect(again.pages.size).toBe(1);
  });

  it("shows the newer entry when two places hold the same page", async () => {
    const book = await Notebook.create("Notizbuch");
    const page = book.add("Seite");
    const listed = book.pages.get(page.id)!;
    const newer = { ...listed, title: "neuer", updated: listed.updated + 1000 };

    manifestPages(book).set(page.id, newer);
    expect(book.pages.get(page.id)?.title).toBe("neuer");
    book.pages.set(page.id, { ...newer, title: "geschrieben" });
    expect(manifestPages(book).has(page.id)).toBe(false);
    expect(book.pages.get(page.id)?.title).toBe("geschrieben");
    book.pages.delete(page.id);
    expect(book.pages.has(page.id)).toBe(false);
  });
});
