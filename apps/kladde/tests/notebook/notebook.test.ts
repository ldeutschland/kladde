import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  saved: [] as string[][],
  refused: new Set<string>(),
  stored: new Set<string>(),
}));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "load_state") return new ArrayBuffer(0);
    if (name !== "save") return undefined;
    const ids = (args.notes as { id: string }[]).map((note) => note.id);

    if (ids.some((id) => native.refused.has(id)))
      throw Error("Invalid notebook data");
    for (const id of ids) native.stored.add(id);
    native.saved.push(ids);

    return undefined;
  }),
}));

const { Notebook } = await import("../../src/notebook/notebook");

beforeEach(() => {
  native.saved = [];
  native.refused = new Set();
  native.stored = new Set();
});

describe("saving", () => {
  it("keeps saving after a late change to a removed page", async () => {
    const book = await Notebook.create("Notizbuch");
    const removed = book.add("entfernt");

    await book.flush();
    book.entries.delete(removed.id);
    book.dirty.delete(removed.id);
    removed.doc.getMap("meta").set("text", "noch getippt");
    await book.flush();
    const other = book.add("andere Seite");

    await book.flush();
    expect(book.error).toBe("");
    expect(book.dirty.size).toBe(0);
    expect(native.stored.has(other.id)).toBe(true);
  });

  it("saves the other pages and retries a refused page only after it changes", async () => {
    const book = await Notebook.create("Notizbuch");
    const bad = book.add("zu groß");
    const good = book.add("normal");

    native.refused.add(bad.id);
    await expect(book.flush()).rejects.toThrow("Invalid notebook data");
    expect(native.stored.has(good.id)).toBe(true);
    expect(good.rev).toBe(1);
    expect([...book.dirty]).toEqual([]);
    const saves = native.saved.length;

    await book.flush();
    expect(native.saved.length).toBe(saves);
    native.refused.clear();
    bad.doc.getMap("meta").set("text", "kürzer");
    await book.flush();
    expect(book.error).toBe("");
    expect(bad.rev).toBe(1);
  });
});

describe("erasing", () => {
  it("unlists first, removes children first and keeps other subpages", async () => {
    const book = await Notebook.create("Notizbuch");
    const parent = book.add("Eltern");
    const child = book.add("Kind", "page", parent.id);
    const other = book.add("eigener Papierkorbstand", "page", parent.id);

    await book.flush();
    const order: string[] = [];

    await book.erase([parent.id, child.id], async (id) => {
      expect(book.pages.has(id)).toBe(false);
      order.push(id);
    });
    expect(order).toEqual([child.id, parent.id]);
    expect(book.pages.get(other.id)?.parent).toBeNull();
    expect(book.entries.has(parent.id)).toBe(false);
    expect(book.dirty.size).toBe(0);
  });

  it("lists the remaining pages again when a removal fails", async () => {
    const book = await Notebook.create("Notizbuch");
    const parent = book.add("Eltern");
    const child = book.add("Kind", "page", parent.id);

    await book.flush();

    const refuse = async (id: string) => {
      if (id === parent.id) throw Error("refused");
    };

    await expect(book.erase([parent.id, child.id], refuse)).rejects.toThrow(
      "refused",
    );
    expect(book.pages.has(parent.id)).toBe(true);
    expect(book.pages.has(child.id)).toBe(false);
  });
});

describe("large databases", () => {
  it("trashes and erases a database without touching each row", async () => {
    const book = await Notebook.create("Notizbuch");
    const database = book.add("Datenbank", "database");
    const rows = Array.from({ length: 300 }, (_, n) =>
      book.add("Zeile " + n, "row", database.id),
    );
    const other = book.add("bleibt");

    await book.flush();
    for (const row of rows) book.release(row.id);
    native.saved = [];
    await book.trashBranch(database.id, 5);
    expect(book.pages.get(rows[42].id)?.archived).toBe(5);
    expect(native.saved.flat()).not.toContain(rows[42].id);
    const removed: string[] = [];

    await book.erase(book.branch(database.id), async (id) => {
      removed.push(id);
    });
    expect(removed).toEqual([database.id]);
    expect(book.pages.size).toBe(1);
    expect(book.pages.has(other.id)).toBe(true);
  });
});

describe("edit time", () => {
  it("moves with typing without rewriting the page entry", async () => {
    const book = await Notebook.create("Notizbuch");
    const page = book.add("Seite");

    await book.flush();
    const created = book.pages.get(page.id)!;

    book.pages.set(page.id, { ...created, updated: created.updated - 60000 });
    const before = book.pages.get(page.id)!;

    page.doc.getMap("meta").set("text", "getippt");
    expect(book.pages.get(page.id)).toBe(before);
    expect(book.editedAt(before)).toBeGreaterThan(before.updated);
    expect(book.dated(page.id)?.updated).toBe(book.editedAt(before));
  });
});
