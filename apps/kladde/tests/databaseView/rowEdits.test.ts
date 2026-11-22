import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createRow,
  renameRow,
  runRowButton,
  storeValue,
  trashRow,
  type RowStore,
} from "../../src/databaseView/rowEdits";
import type { Field, FieldType, Row } from "../../src/database/types";
import type { Entry, Notebook, Page } from "../../src/notebook/notebook";

const TITLE_LIMIT = 200;

const field = (
  id: string,
  type: FieldType,
  extra: Partial<Field> = {},
): Field => ({ id, name: id, type, options: [], ...extra });

function setup() {
  const db: Entry = { id: "db", doc: new Y.Doc(), rev: 0, kind: "database" };
  const entries = new Map<string, Entry>();
  const pages = new Map<string, Partial<Page>>();
  const calls: string[] = [];
  let rows: Row[] = [];
  const page = (id: string, parent: string, title = id) => {
    pages.set(id, { id, parent, title, kind: "row" });
    entries.set(id, { id, doc: new Y.Doc(), rev: 0, kind: "row" });
    rows.push({ id, title, values: {} });
  };
  const book = {
    pages,
    add: (title: string, _kind: string, parent: string) => {
      const id = "new" + entries.size;

      page(id, parent, title);

      return entries.get(id);
    },
    load: async (id: string) => {
      calls.push("load:" + id);

      return entries.get(id)!;
    },
    change: async (id: string, patch: Partial<Page>) => {
      calls.push("change:" + id + ":" + patch.title);
    },
    trashBranch: async (id: string) => {
      calls.push("trash:" + id);
    },
    flush: async () => {
      calls.push("flush");
    },
  };
  const store: RowStore = {
    book: book as unknown as Notebook,
    db,
    setRows: (next) => {
      calls.push("setRows");
      rows = typeof next === "function" ? next(rows) : next;
    },
  };
  const props = (id: string) =>
    entries.get(id)!.doc.getMap<string>("properties");

  page("mine", "db");
  page("foreign", "other");

  return { store, calls, props, db, rows: () => rows };
}

describe("storing cell values", () => {
  it("stores a trimmed valid value and updates the shown row", async () => {
    const { store, props, rows } = setup();

    expect(await storeValue(store, "mine", field("n", "number"), " 42 ")).toBe(
      true,
    );
    expect(props("mine").get("n")).toBe("42");
    expect(rows().find((r) => r.id === "mine")?.values).toEqual({ n: "42" });
  });

  it("refuses invalid values without loading the row", async () => {
    const { store, calls } = setup();
    const url = field("u", "url");

    expect(await storeValue(store, "mine", url, "javascript:alert(1)")).toBe(
      false,
    );
    expect(await storeValue(store, "mine", field("f", "formula"), "1")).toBe(
      false,
    );
    expect(calls).toEqual([]);
  });

  it("refuses rows that belong to another database", async () => {
    const { store, calls, props } = setup();

    expect(await storeValue(store, "foreign", field("t", "text"), "x")).toBe(
      false,
    );
    expect(await storeValue(store, "missing", field("t", "text"), "x")).toBe(
      false,
    );
    expect(props("foreign").size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("skips writing when the value is unchanged", async () => {
    const { store, calls, props } = setup();

    props("mine").set("t", "same");
    expect(await storeValue(store, "mine", field("t", "text"), "same")).toBe(
      true,
    );
    expect(calls).toEqual(["load:mine"]);
  });
});

describe("row titles and trash", () => {
  it("trims and caps titles", async () => {
    const { store, calls, rows } = setup();
    const long = "  " + "x".repeat(TITLE_LIMIT + 50) + "  ";

    expect(await renameRow(store, "mine", long)).toBe(true);
    expect(calls[0]).toBe("change:mine:" + "x".repeat(TITLE_LIMIT));
    expect(rows().find((r) => r.id === "mine")?.title).toHaveLength(
      TITLE_LIMIT,
    );
  });

  it("does not rename or trash rows of another database", async () => {
    const { store, calls } = setup();

    expect(await renameRow(store, "foreign", "x")).toBe(false);
    await trashRow(store, "foreign");
    expect(calls).toEqual([]);
  });

  it("trashes a row and removes it from the list", async () => {
    const { store, calls, rows } = setup();

    await trashRow(store, "mine");
    expect(calls).toEqual(["trash:mine", "setRows"]);
    expect(rows().map((r) => r.id)).toEqual(["foreign"]);
  });
});

describe("new rows", () => {
  const status = field("s", "status", { options: ["Open", "Done"] });

  it("appends the row to the order and fills a valid group value", async () => {
    const { store, db, props } = setup();
    const id = await createRow(store, status, "Done");

    expect(db.doc.getArray("row_order").toArray()).toEqual([id]);
    expect(props(id).get("s")).toBe("Done");
  });

  it("leaves the group empty for unknown values", async () => {
    const { store, props } = setup();
    const id = await createRow(store, status, "Hacked");

    expect(props(id).size).toBe(0);
  });
});

describe("row buttons", () => {
  it("does nothing without a rule or for rows of another database", async () => {
    const { store, calls } = setup();
    const button = field("b", "button", { rule: "r" });

    await runRowButton(
      store,
      { id: "mine", title: "", values: {} },
      field("b", "button"),
    );
    await runRowButton(store, { id: "foreign", title: "", values: {} }, button);
    expect(calls).toEqual([]);
  });
});
