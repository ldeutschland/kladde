import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import * as Y from "yjs";
import { csv, importCsv } from "../../src/database/csv";
import { fields, views } from "../../src/database/fields";
import type { Field, Row } from "../../src/database/types";
import type { Entry, Notebook } from "../../src/notebook/notebook";

const MAX_TEXT = 8_000_000;
const MAX_COLUMNS = 101;
const MAX_ROWS = 10000;

const field = (id: string, name = id): Field => ({
  id,
  name,
  type: "text",
  options: [],
});

const row = (title: string, values: Record<string, string> = {}): Row => ({
  id: title,
  title,
  values,
});

function fakeBook() {
  const added: { entry: Entry; title: string; parent: string | null }[] = [];
  let flushes = 0;
  const book = {
    add: (title: string, kind: Entry["kind"], parent: string | null) => {
      const entry: Entry = {
        id: "e" + added.length,
        doc: new Y.Doc(),
        rev: 0,
        kind,
      };

      added.push({ entry, title, parent });

      return entry;
    },
    flush: async () => {
      flushes++;
    },
  };

  return {
    book: book as unknown as Notebook,
    added,
    flushes: () => flushes,
  };
}

const parse = (text: string) => Papa.parse<string[]>(text).data;

describe("csv export", () => {
  it("writes a title column followed by the schema in order", () => {
    const schema = [field("b", "Beta"), field("a", "Alpha")];
    const text = csv([row("One", { a: "1", b: "2" })], schema);

    expect(parse(text)).toEqual([
      ["Title", "Beta", "Alpha"],
      ["One", "2", "1"],
    ]);
  });

  it("leaves missing values empty and ignores values outside the schema", () => {
    const text = csv([row("One", { other: "secret" })], [field("a")]);

    expect(parse(text)).toEqual([
      ["Title", "a"],
      ["One", ""],
    ]);
    expect(text).not.toContain("secret");
  });

  it.each(["=SUM(A1)", "+1+1", "-2+3", "@cmd", "\t=1", "\r=1"])(
    "neutralises the formula prefix in %j",
    (cell) => {
      const [, [title, value]] = parse(
        csv([row(cell, { a: cell })], [field("a")]),
      );

      expect(title).toBe("'" + cell);
      expect(value).toBe("'" + cell);
    },
  );

  it("escapes formula prefixes in property names", () => {
    const [header] = parse(csv([], [field("a", "=cmd")]));

    expect(header).toEqual(["Title", "'=cmd"]);
  });

  it("neutralises a formula prefix in a multi-line cell", () => {
    const cell = '=HYPERLINK("http://x")\nnote';
    const value = "+SUM(A1)\r\nmore";
    const [, [title, property]] = parse(
      csv([row(cell, { a: value })], [field("a")]),
    );

    expect(title).toBe("'" + cell);
    expect(property).toBe("'" + value);
  });

  it("round-trips quotes, separators, line breaks and unicode", () => {
    const tricky = 'He said "hi", then\nleft 👋 ä';
    const [, [title, value]] = parse(
      csv([row(tricky, { a: "x;y,z" })], [field("a")]),
    );

    expect(title).toBe(tricky);
    expect(value).toBe("x;y,z");
  });
});

describe("csv import", () => {
  it("creates a database with text properties, a table view and ordered rows", async () => {
    const { book, added } = fakeBook();
    const db = await importCsv(
      book,
      "Clients",
      "Title,City,Size\nAcme,Berlin,3\nBeta,Köln,",
      "parent",
    );
    const schema = [...fields(db).values()];
    const rows = added.filter((a) => a.parent === db.id);

    expect(added[0]).toMatchObject({ title: "Clients", parent: "parent" });
    expect(schema.map((f) => [f.name, f.type])).toEqual([
      ["City", "text"],
      ["Size", "text"],
    ]);
    expect([...views(db).values()].map((v) => v.type)).toEqual(["table"]);
    expect(rows.map((r) => r.title)).toEqual(["Acme", "Beta"]);
    expect(db.doc.getArray("row_order").toArray()).toEqual(
      rows.map((r) => r.entry.id),
    );
    expect(rows[1].entry.doc.getMap("properties").get(schema[0].id)).toBe(
      "Köln",
    );
    expect(rows[1].entry.doc.getMap("properties").get(schema[1].id)).toBe("");
  });

  it("skips blank lines and flushes in batches of a hundred rows", async () => {
    const { book, added, flushes } = fakeBook();
    const lines = Array.from({ length: 250 }, (_, i) => "r" + i + ",v");

    await importCsv(book, "Big", "Title,A\n\n" + lines.join("\n") + "\n\n");

    expect(added.filter((a) => a.entry.kind === "row")).toHaveLength(250);
    expect(flushes()).toBe(3);
  });

  it("keeps property names like __proto__ as plain text fields", async () => {
    const { book, added } = fakeBook();
    const db = await importCsv(book, "P", "Title,__proto__\nrow,value");
    const [only] = [...fields(db).values()];
    const properties = added[1].entry.doc.getMap("properties");

    expect(only.name).toBe("__proto__");
    expect(only.id).not.toBe("__proto__");
    expect(properties.toJSON()).toEqual({ [only.id]: "value" });
  });

  it("rejects text above the size limit before parsing", async () => {
    const { book, added } = fakeBook();

    await expect(
      importCsv(book, "x", "a".repeat(MAX_TEXT + 1)),
    ).rejects.toThrow("CSV too large");
    expect(added).toHaveLength(0);
  });

  it("accepts the column limit and rejects one more", async () => {
    const header = (count: number) =>
      Array.from({ length: count }, (_, i) => "c" + i).join(",");

    await expect(
      importCsv(fakeBook().book, "ok", header(MAX_COLUMNS)),
    ).resolves.toBeDefined();
    await expect(
      importCsv(fakeBook().book, "no", header(MAX_COLUMNS + 1)),
    ).rejects.toThrow("Invalid CSV");
  });

  it("rejects more rows than the limit without creating anything", async () => {
    const { book, added } = fakeBook();
    const text =
      "Title\n" +
      Array(MAX_ROWS + 1)
        .fill("r")
        .join("\n");

    await expect(importCsv(book, "x", text)).rejects.toThrow("Invalid CSV");
    expect(added).toHaveLength(0);
  });

  it.each([
    ["empty input", ""],
    ["ragged rows", "Title,A\nr1,1,extra"],
    ["blank property names", "Title, \nr1,1"],
    ["overlong property names", "Title," + "n".repeat(201) + "\nr1,1"],
    ["unterminated quotes", 'Title,A\n"r1,1'],
  ])("rejects %s", async (_, text) => {
    const { book, added } = fakeBook();

    await expect(importCsv(book, "x", text)).rejects.toThrow("Invalid CSV");
    expect(added).toHaveLength(0);
  });
});
