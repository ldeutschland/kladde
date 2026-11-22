import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addGroupField,
  changeView,
  removeField,
  renameField,
  updateField,
} from "../../src/databaseView/viewEdits";
import { fields, views } from "../../src/database/fields";
import { counters } from "../../src/database/rules";
import type { Field, FieldType, View } from "../../src/database/types";
import type { T } from "../../src/locale/locale";
import type { Entry, Notebook } from "../../src/notebook/notebook";

const t: T = (key) => "~" + key;

const field = (
  id: string,
  type: FieldType,
  extra: Partial<Field> = {},
): Field => ({ id, name: id, type, options: [], ...extra });

const baseView: View = {
  id: "v",
  name: "v",
  type: "table",
  filters: [],
  match: "all",
  sort: "",
  descending: false,
  group: "",
  visible: null,
  widths: {},
};

function database(schema: Field[] = []) {
  const db: Entry = { id: "db", doc: new Y.Doc(), rev: 0, kind: "database" };

  for (const f of schema) fields(db).set(f.id, f);

  return db;
}

const noRowsBook = {
  pages: new Map(),
  flush: async () => {},
} as unknown as Notebook;

describe("view edits", () => {
  it("merges a patch into the stored view", () => {
    const db = database();

    changeView(db, baseView, { sort: "n", descending: true });
    expect(views(db).get("v")).toEqual({
      ...baseView,
      sort: "n",
      descending: true,
    });
  });

  it("removes every reference to a deleted property from all views", () => {
    const db = database([field("n", "number"), field("t", "text")]);
    const onN = { field: "n", value: "1" };
    const onT = { field: "t", value: "x" };
    const view: View = {
      ...baseView,
      sort: "n",
      group: "n",
      filters: [onN, onT],
      groups: [{ filters: [onN, onT], match: "any" }],
      thenSort: [
        { field: "n", descending: true },
        { field: "t", descending: false },
      ],
      summary: { field: "n", calculation: "sum" },
      calcs: { n: "sum", t: "count" },
      tints: [{ filters: [onN, onT], match: "all", color: 2 }],
    };
    const other: View = { ...baseView, id: "w", sort: "t" };

    removeField(db, [view, other], "n");
    const cleaned = views(db).get("v")!;

    expect(fields(db).has("n")).toBe(false);
    expect(cleaned).toMatchObject({
      sort: "",
      group: "",
      filters: [onT],
      groups: [{ filters: [onT], match: "any" }],
      thenSort: [{ field: "t", descending: false }],
      summary: undefined,
      calcs: { t: "count" },
      tints: [{ filters: [onT], match: "all", color: 2 }],
    });
    expect(views(db).get("w")).toMatchObject({ sort: "t" });
  });

  it("removes a property and cleans views in a single transaction", () => {
    const db = database([field("n", "number")]);
    let updates = 0;

    db.doc.on("update", () => updates++);
    removeField(db, [baseView, { ...baseView, id: "w" }], "n");
    expect(updates).toBe(1);
  });
});

describe("property edits", () => {
  it("renames with a trimmed name and ignores blank names", () => {
    const db = database([field("n", "number", { name: "Old" })]);

    renameField(db, "n", "  New  ");
    expect(fields(db).get("n")?.name).toBe("New");
    renameField(db, "n", "   ");
    expect(fields(db).get("n")?.name).toBe("New");
    renameField(db, "missing", "X");
    expect(fields(db).has("missing")).toBe(false);
  });

  it("patches a property and keeps its options unless replaced", () => {
    const db = database([field("s", "select", { options: ["a", "b"] })]);

    updateField(noRowsBook, db, "s", { name: "State" });
    expect(fields(db).get("s")).toMatchObject({
      name: "State",
      options: ["a", "b"],
    });
    updateField(noRowsBook, db, "s", { options: ["c"] });
    expect(fields(db).get("s")?.options).toEqual(["c"]);
  });

  it("does not create a property when updating an unknown id", () => {
    const db = database();

    updateField(noRowsBook, db, "ghost", { name: "Ghost" });
    expect(fields(db).size).toBe(0);
  });

  it("numbers existing rows when a property becomes an automatic id", async () => {
    const db = database([field("n", "number")]);
    const rowEntry: Entry = { id: "r", doc: new Y.Doc(), rev: 0, kind: "row" };
    const book = {
      pages: new Map([
        ["r", { id: "r", kind: "row", parent: "db", order: 1, archived: null }],
      ]),
      load: async () => rowEntry,
      flush: async () => {},
    } as unknown as Notebook;

    updateField(book, db, "n", { type: "autoId" });
    await new Promise((resolve) => setTimeout(resolve));
    expect(fields(db).get("n")?.type).toBe("autoId");
    expect(rowEntry.doc.getMap("properties").get("n")).toBe("1");
    expect(counters(db).get("n")).toBe(1);
  });

  it("does not renumber a property that already is an automatic id", () => {
    const db = database([field("n", "autoId")]);

    counters(db).set("n", 7);
    updateField(noRowsBook, db, "n", { name: "Number", type: "autoId" });
    expect(counters(db).get("n")).toBe(7);
  });
});

describe("group properties", () => {
  it("adds a status property with default options for boards", () => {
    const db = database();

    addGroupField(db, t, [], "board");
    expect([...fields(db).values()]).toEqual([
      expect.objectContaining({
        name: "~status",
        type: "status",
        options: ["~statusTodo", "~statusDoing", "~statusDone"],
      }),
    ]);
  });

  it("adds a date property for calendars", () => {
    const db = database();

    addGroupField(db, t, [], "calendar");
    expect([...fields(db).values()].map((f) => [f.name, f.type])).toEqual([
      ["~date", "date"],
    ]);
  });

  it("adds nothing when a fitting property exists or the layout needs none", () => {
    const db = database();

    addGroupField(db, t, [field("k", "select")], "board");
    addGroupField(db, t, [field("d", "date")], "calendar");
    addGroupField(db, t, [], "table");
    addGroupField(db, t, [], "gallery");
    expect(fields(db).size).toBe(0);
  });
});
