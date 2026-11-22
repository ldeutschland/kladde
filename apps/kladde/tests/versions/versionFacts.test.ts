import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Entry, Kind, Stored } from "../../src/notebook/notebook";
import { translator } from "../../src/locale/locale";

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string) =>
    name === "load_state" ? new ArrayBuffer(0) : undefined,
  ),
}));

const { Notebook } = await import("../../src/notebook/notebook");
const { versionFacts } = await import("../../src/versions/versionFacts");

const t = translator("en");

function snapshot(id: string, kind: Kind, doc = new Y.Doc()): Entry {
  return { id, doc, rev: 1, kind };
}

function stored(title: string): Stored {
  return {
    id: "",
    space: "",
    kind: "page",
    title,
    body: "",
    parent: null,
    archived: false,
    props: "{}",
    links: [],
    data: [],
    rev: 1,
  };
}

function properties(entry: Entry, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values))
    entry.doc.getMap("properties").set(key, value);
}

function field(entry: Entry, id: string, name: string, type = "text") {
  entry.doc.getMap("schema").set(id, { id, name, type, options: [] });
}

describe("facts about a version", () => {
  it("reports a renamed page and nothing when the title is the same", async () => {
    const book = await Notebook.create("Notizbuch");
    const page = book.add("Neu");
    const old = snapshot(page.id, "page");

    expect(versionFacts(book, stored("Alt"), old, page, null, t)).toEqual([
      { key: "title", label: "Title", before: "Alt", after: "Neu" },
    ]);
    expect(versionFacts(book, stored("Neu"), old, page, null, t)).toEqual([]);
  });

  it("lists only the row properties that changed, labelled by their field", async () => {
    const book = await Notebook.create("Notizbuch");
    const database = book.add("Tabelle", "database");
    const row = book.add("Zeile", "row", database.id);
    const old = snapshot(row.id, "row");

    field(database, "f-status", "Status");
    properties(old, {
      "f-status": "offen",
      "f-same": "gleich",
      "f-gone": "weg",
    });
    properties(row, { "f-status": "erledigt", "f-same": "gleich", "f-new": 3 });

    const facts = versionFacts(book, stored("Zeile"), old, row, database, t);

    expect(facts).toEqual([
      {
        key: "property:f-status",
        label: "Status",
        before: "offen",
        after: "erledigt",
      },
      { key: "property:f-gone", label: "f-gone", before: "weg", after: "" },
      { key: "property:f-new", label: "f-new", before: "", after: "3" },
    ]);
  });

  it("shows related rows by title and keeps unknown ids as they are", async () => {
    const book = await Notebook.create("Notizbuch");
    const database = book.add("Tabelle", "database");
    const target = book.add("Ziel", "row", database.id);
    const row = book.add("Zeile", "row", database.id);
    const old = snapshot(row.id, "row");

    database.doc.getMap("schema").set("f-rel", {
      id: "f-rel",
      name: "Bezug",
      type: "relation",
      options: [],
      target: database.id,
    });
    properties(old, { "f-rel": "" });
    properties(row, { "f-rel": `${target.id}, unbekannt` });

    const [fact] = versionFacts(book, stored("Zeile"), old, row, database, t);

    expect(fact).toMatchObject({
      label: "Bezug",
      before: "",
      after: "Ziel, unbekannt",
    });
  });

  it("ignores properties on pages that are not rows", async () => {
    const book = await Notebook.create("Notizbuch");
    const page = book.add("Seite");
    const old = snapshot(page.id, "page");

    properties(old, { x: "1" });
    properties(page, { x: "2" });
    expect(versionFacts(book, stored("Seite"), old, page, null, t)).toEqual([]);
  });

  it("reports added, removed and renamed fields and views of a database", async () => {
    const book = await Notebook.create("Notizbuch");
    const database = book.add("Tabelle", "database");
    const old = snapshot(database.id, "database");

    field(old, "f-a", "Name");
    field(old, "f-b", "Entfernt");
    field(database, "f-a", "Titel");
    field(database, "f-c", "Neu");
    field(database, "f-bad", "Kaputt", "no-such-type");
    database.doc.getMap("views").set("v-1", { id: "v-1", name: "Tafel" });

    const facts = versionFacts(book, stored("Tabelle"), old, database, null, t);

    expect(facts).toEqual([
      { key: "field:f-a", label: "Property", before: "Name", after: "Titel" },
      { key: "field:f-b", label: "Property", before: "Entfernt", after: "" },
      { key: "field:f-c", label: "Property", before: "", after: "Neu" },
      { key: "view:v-1", label: "View", before: "", after: "Tafel" },
    ]);
  });
});
