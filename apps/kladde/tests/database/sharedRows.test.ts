import { describe, expect, it } from "vitest";
import {
  sharedRows,
  sharedScope,
  visibleLinks,
  visibleTitles,
} from "../../src/database/sharedRows";
import type { Field, FieldType, Row } from "../../src/database/types";
import type { Notebook, Page } from "../../src/notebook/notebook";

const field = (id: string, type: FieldType, target?: string): Field => ({
  id,
  name: id,
  type,
  options: [],
  target,
});

const row = (id: string, values: Record<string, string> = {}): Row => ({
  id,
  title: id,
  values,
});

const hidden = (id: string) => id.startsWith("secret");

function bookOf(pages: Partial<Page>[]) {
  const loads: string[] = [];
  const book = {
    pages: new Map(pages.map((p) => [p.id!, p])),
    load: async (id: string) => {
      loads.push(id);
      throw Error("unexpected load");
    },
  };

  return { book: book as unknown as Notebook, loads };
}

describe("shared rows", () => {
  const schema = [
    field("links", "relation", "people"),
    field("more", "relation", "people"),
    field("note", "text"),
  ];

  it("removes hidden rows and hidden links but keeps other values", () => {
    const rows = [
      row("a", { links: "p1, secret1 ,p2", more: "secret2", note: "secret3" }),
      row("secret-row", { links: "p1" }),
    ];

    expect(sharedRows(rows, schema, hidden)).toEqual([
      row("a", { links: "p1,p2", more: "", note: "secret3" }),
    ]);
  });

  it("returns untouched rows as the same objects", () => {
    const clean = row("a", { links: "p1" });

    expect(sharedRows([clean], schema, hidden)[0]).toBe(clean);
    expect(visibleLinks(clean, schema, hidden)).toBe(clean);
  });

  it("does not change the original row when filtering links", () => {
    const original = row("a", { links: "p1,secret1" });
    const visible = visibleLinks(original, schema, hidden);

    expect(visible.values.links).toBe("p1");
    expect(original.values.links).toBe("p1,secret1");
  });
});

describe("shared titles", () => {
  it("blanks titles of hidden pages", () => {
    const { book } = bookOf([
      { id: "p1", title: "Ada" },
      { id: "secret1", title: "Classified" },
    ]);
    const scope = visibleTitles(book, hidden);

    expect(scope.pageTitle("p1")).toBe("Ada");
    expect(scope.pageTitle("secret1")).toBe("");
    expect(scope.pageTitle("missing")).toBe("");
  });

  it("never loads hidden or non-database relation targets", async () => {
    const { book, loads } = bookOf([
      { id: "secret-db", kind: "database" },
      { id: "page", kind: "page" },
    ]);
    const schema = [
      field("f", "formula"),
      field("a", "relation", "secret-db"),
      field("b", "relation", "page"),
      field("c", "relation", "missing"),
    ];
    const scope = await sharedScope(book, schema, hidden);

    expect(loads).toEqual([]);
    expect(scope.related.size).toBe(0);
  });

  it("skips loading linked databases when nothing is computed", async () => {
    const { book, loads } = bookOf([{ id: "people", kind: "database" }]);

    await sharedScope(book, [field("a", "relation", "people")], hidden);
    expect(loads).toEqual([]);
  });
});
