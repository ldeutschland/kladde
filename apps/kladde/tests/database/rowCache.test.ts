import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Entry, Notebook } from "../../src/notebook/notebook";

type Stored = [string, string, string];
type Changed = [string, string, string, boolean];

const native = vi.hoisted(() => ({
  pages: [] as [Stored[], number | null, number][],
  changes: [] as [Changed[], number | null, number][],
  calls: [] as { name: string; after?: number; since?: number }[],
}));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: Record<string, number>) => {
    native.calls.push({ name, after: args.after, since: args.since });
    if (name === "rows") return native.pages.shift();

    return native.changes.shift() ?? [[], null, args.since];
  }),
}));

const { retainRows, rowIndex } = await import("../../src/database/rowIndex");
const { rowSnapshot } = await import("../../src/database/computedRows");

function fixture() {
  const db: Entry = { id: "db", doc: new Y.Doc(), rev: 1, kind: "database" };
  const linked: Entry = { ...db, id: "linked", doc: new Y.Doc() };
  const get = (id: string) =>
    id === "linked" ? { kind: "database" } : undefined;
  const pages = { version: 0, rowsOf: async () => {}, get };
  const book = {
    id: "book",
    pages,
    dated: () => undefined,
    load: async () => linked,
  };

  return { book: book as unknown as Notebook, db, linked };
}

const loads = () => native.calls.filter((call) => call.name === "rows").length;

const row = (id: string, title = id): Stored => [id, title, "{}"];

beforeEach(() => {
  vi.useFakeTimers();
  native.pages = [];
  native.changes = [];
  native.calls = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("database rows", () => {
  it("loads every page and shows the first ones while the rest arrives", async () => {
    const { book, db } = fixture();

    native.pages = [
      [[row("a"), row("b")], 2, 7],
      [[row("c")], null, 9],
    ];
    const partial: number[] = [];
    const rows = await rowIndex(book, db, (loaded) =>
      partial.push(loaded.length),
    );

    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(partial).toEqual([2]);
    expect(native.calls.map((c) => c.after)).toEqual([0, 2]);
  });

  it("only asks for changes afterwards and keeps the list when nothing changed", async () => {
    const { book, db } = fixture();

    native.pages = [[[row("a"), row("b")], null, 7]];
    const first = await rowIndex(book, db);
    const second = await rowIndex(book, db);

    expect(second).toBe(first);
    expect(native.calls.at(-1)).toEqual({ name: "rows_changed", since: 7 });
    native.changes = [
      [
        [
          ["a", "neu", "{}", false],
          ["b", "", "{}", true],
        ],
        null,
        12,
      ],
    ];
    const third = await rowIndex(book, db);

    expect(third.map((r) => r.title)).toEqual(["neu"]);
    await rowIndex(book, db);
    expect(native.calls.at(-1)?.since).toBe(12);
  });

  it("hands out the same snapshot until rows or fields change", async () => {
    const { book, db } = fixture();

    native.pages = [[[row("a")], null, 1]];
    const first = await rowSnapshot(book, db);

    expect(await rowSnapshot(book, db)).toBe(first);
    native.changes = [[[["a", "anders", "{}", false]], null, 2]];
    const second = await rowSnapshot(book, db);

    expect(second).not.toBe(first);
    expect(second.rows[0].title).toBe("anders");
  });

  it("keeps the rows of an open database and frees them after it closes", async () => {
    const { book, db } = fixture();

    native.pages = [[[row("a")], null, 1]];
    const release = retainRows(book, db.id);

    await rowIndex(book, db);
    await vi.advanceTimersByTimeAsync(120000);
    await rowIndex(book, db);
    expect(loads()).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(31000);
    native.pages = [[[row("a")], null, 1]];
    await rowIndex(book, db);
    expect(loads()).toBe(2);
  });

  it("keeps a linked database loaded while the database using it is open", async () => {
    const { book, db, linked } = fixture();
    const schema = db.doc.getMap("schema");

    schema.set("link", {
      id: "link",
      name: "l",
      type: "relation",
      options: [],
      target: "linked",
    });
    schema.set("sum", {
      id: "sum",
      name: "s",
      type: "formula",
      options: [],
      formula: "1",
    });
    native.pages = [
      [[row("x")], null, 1],
      [[row("a")], null, 1],
    ];
    const release = retainRows(book, db.id);

    await rowSnapshot(book, db);
    await vi.advanceTimersByTimeAsync(120000);
    await rowIndex(book, linked);
    expect(loads()).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(61000);
    native.pages = [[[row("x")], null, 1]];
    await rowIndex(book, linked);
    expect(loads()).toBe(3);
  });
});
