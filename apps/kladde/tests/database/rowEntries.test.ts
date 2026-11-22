import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { renameOption, rowEntries } from "../../src/database/rowEntries";
import type { Entry, Notebook, Page } from "../../src/notebook/notebook";

const db: Entry = { id: "db", doc: new Y.Doc(), rev: 0, kind: "database" };

function bookWith(pages: Partial<Page>[], values: Record<string, string>) {
  const entries = new Map<string, Entry>();
  let flushes = 0;

  for (const page of pages) {
    const entry: Entry = {
      id: page.id!,
      doc: new Y.Doc(),
      rev: 0,
      kind: "row",
    };

    if (values[page.id!] !== undefined)
      entry.doc.getMap("properties").set("tags", values[page.id!]);
    entries.set(page.id!, entry);
  }

  const book = {
    pages: new Map(pages.map((p) => [p.id!, p])),
    load: async (id: string) => entries.get(id)!,
    flush: async () => {
      flushes++;
    },
  };
  const tags = (id: string) =>
    entries.get(id)!.doc.getMap<string>("properties").get("tags");

  return { book: book as unknown as Notebook, tags, flushes: () => flushes };
}

const rowPage = (id: string, extra: Partial<Page> = {}): Partial<Page> => ({
  id,
  kind: "row",
  parent: "db",
  archived: null,
  ...extra,
});

describe("row entries", () => {
  it("loads only live rows of the database", async () => {
    const { book } = bookWith(
      [
        rowPage("a"),
        rowPage("trashed", { archived: 1 }),
        rowPage("foreign", { parent: "other" }),
        rowPage("child", { kind: "page" }),
      ],
      {},
    );

    expect((await rowEntries(book, db)).map((e) => e.id)).toEqual(["a"]);
  });
});

describe("renaming options", () => {
  it("renames exact entries in every row and flushes once", async () => {
    const { book, tags, flushes } = bookWith(
      [rowPage("a"), rowPage("b"), rowPage("c")],
      { a: "Open, Later", b: "Opened", c: "Later" },
    );

    await renameOption(book, db, "tags", "Open", "Doing");

    expect(tags("a")).toBe("Doing,Later");
    expect(tags("b")).toBe("Opened");
    expect(tags("c")).toBe("Later");
    expect(flushes()).toBe(1);
  });

  it("leaves rows without the option untouched", async () => {
    const { book, tags } = bookWith([rowPage("a"), rowPage("b")], {
      a: " Later ,  Soon",
    });

    await renameOption(book, db, "tags", "Open", "Doing");

    expect(tags("a")).toBe(" Later ,  Soon");
    expect(tags("b")).toBeUndefined();
  });

  it("does not touch trashed rows", async () => {
    const { book, tags } = bookWith([rowPage("a", { archived: 1 })], {
      a: "Open",
    });

    await renameOption(book, db, "tags", "Open", "Doing");

    expect(tags("a")).toBe("Open");
  });
});
