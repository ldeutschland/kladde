import { beforeEach, describe, expect, it, vi } from "vitest";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import type { Entry } from "../../src/notebook/notebook";

const core = vi.hoisted(() => ({
  files: new Map<string, string>(),
  unreadable: false,
}));

vi.mock("../../src/platform/native", () => ({
  fileBase64: async (blob: Blob) =>
    Buffer.from(await blob.arrayBuffer()).toString("base64"),
  command: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "load_state") return new ArrayBuffer(0);

    if (name === "add_file") {
      const id = crypto.randomUUID();

      core.files.set(id, String(args.data));

      return id;
    }

    if (name === "read_file") {
      const data = core.files.get(String(args.id));

      if (!data || core.unreadable) throw Error("File missing");

      return new Uint8Array(Buffer.from(data, "base64")).buffer;
    }

    return undefined;
  }),
}));

const { Notebook } = await import("../../src/notebook/notebook");
const { blockEditor, blocks } = await import("../../src/notebook/content");
const { copyPages } = await import("../../src/notebook/copyPages");

type Book = Awaited<ReturnType<typeof Notebook.create>>;
type Written = ReturnType<typeof blocks>;

const REFERENCE = /kladde(?:-file)?:[0-9a-f-]{36}/g;

function write(entry: Entry, content: unknown[]) {
  const written = content.map((block) => ({
    id: crypto.randomUUID(),
    ...(block as object),
  }));

  blocksToYXmlFragment(
    blockEditor(),
    written as Written,
    entry.doc.getXmlFragment("blocks"),
  );
}

function linkTo(id: string, text = "Link") {
  return {
    type: "paragraph",
    content: [
      {
        type: "link",
        href: "kladde:" + id,
        content: [{ type: "text", text, styles: {} }],
      },
    ],
  };
}

function references(entry: Entry): string[] {
  return JSON.stringify(blocks(entry)).match(REFERENCE) ?? [];
}

function childrenOf(book: Book, parent: string) {
  return [...book.pages.values()].filter(
    (page) => page.parent === parent && !page.archived,
  );
}

beforeEach(() => {
  core.files = new Map();
  core.unreadable = false;
});

describe("duplicating pages", () => {
  it("copies the whole branch with fresh ids next to the original", async () => {
    const book = await Notebook.create("Notizbuch");
    const home = book.add("Start");
    const root = book.add("Projekt", "page", home.id);
    const child = book.add("Kapitel", "page", root.id);

    book.add("Absatz", "page", child.id);
    const copy = await copyPages(book, book, root.id, false);
    const copied = book.pages.get(copy)!;
    const [copiedChild] = childrenOf(book, copy);

    expect(copy).not.toBe(root.id);
    expect(copied).toMatchObject({
      title: "Projekt (2)",
      parent: home.id,
      archived: null,
    });
    expect(copiedChild.title).toBe("Kapitel");
    expect(copiedChild.id).not.toBe(child.id);
    expect(childrenOf(book, copiedChild.id).map((page) => page.title)).toEqual([
      "Absatz",
    ]);
    expect(book.pages.get(root.id)).toMatchObject({
      title: "Projekt",
      archived: null,
    });
    expect(childrenOf(book, root.id).map((page) => page.id)).toEqual([
      child.id,
    ]);
  });

  it("points links inside the branch to the copies and keeps outside links", async () => {
    const book = await Notebook.create("Notizbuch");
    const outside = book.add("Außen");
    const root = book.add("Wurzel");
    const child = book.add("Kind", "page", root.id);

    write(root, [linkTo(child.id), linkTo(outside.id)]);
    write(child, [linkTo(root.id)]);
    const copy = await copyPages(book, book, root.id, false);
    const [copiedChild] = childrenOf(book, copy);

    expect(references(await book.load(copy))).toEqual([
      "kladde:" + copiedChild.id,
      "kladde:" + outside.id,
    ]);
    expect(references(await book.load(copiedChild.id))).toEqual([
      "kladde:" + copy,
    ]);
    expect(references(root)).toEqual([
      "kladde:" + child.id,
      "kladde:" + outside.id,
    ]);
  });

  it("leaves archived children behind", async () => {
    const book = await Notebook.create("Notizbuch");
    const root = book.add("Wurzel");

    book.add("bleibt", "page", root.id);
    const gone = book.add("gelöscht", "page", root.id);

    await book.change(gone.id, { archived: Date.now() });
    const copy = await copyPages(book, book, root.id, false);

    expect(childrenOf(book, copy).map((page) => page.title)).toEqual([
      "bleibt",
    ]);
  });

  it("remaps rows, row order, relations and field targets of a copied database", async () => {
    const book = await Notebook.create("Notizbuch");
    const db = book.add("Tabelle", "database");
    const first = book.add("Erste", "row", db.id);
    const second = book.add("Zweite", "row", db.id);
    const field = {
      id: "rel",
      name: "Bezug",
      type: "relation",
      options: [],
      target: db.id,
    };

    db.doc.getMap("schema").set("rel", field);
    db.doc.getArray<string>("row_order").push([second.id, first.id]);
    second.doc.getMap("properties").set("rel", first.id);
    const copy = await copyPages(book, book, db.id, false);
    const copyEntry = await book.load(copy);
    const rows = new Map(
      childrenOf(book, copy).map((page) => [page.title, page.id]),
    );
    const copiedSecond = await book.load(rows.get("Zweite")!);

    expect(copyEntry.doc.getArray("row_order").toArray()).toEqual([
      rows.get("Zweite"),
      rows.get("Erste"),
    ]);
    expect(copiedSecond.doc.getMap("properties").get("rel")).toBe(
      rows.get("Erste"),
    );
    expect(copyEntry.doc.getMap("schema").get("rel")).toMatchObject({
      target: copy,
    });
  });

  it("remaps every target of a relation with several rows", async () => {
    const book = await Notebook.create("Notizbuch");
    const db = book.add("Tabelle", "database");
    const first = book.add("Erste", "row", db.id);
    const second = book.add("Zweite", "row", db.id);
    const outside = crypto.randomUUID();

    db.doc.getMap("schema").set("rel", {
      id: "rel",
      name: "Bezug",
      type: "relation",
      options: [],
      target: db.id,
    });
    db.doc.getArray<string>("row_order").push([first.id, second.id]);
    second.doc
      .getMap("properties")
      .set("rel", [first.id, second.id, outside].join(","));
    const copy = await copyPages(book, book, db.id, false);
    const rows = new Map(
      childrenOf(book, copy).map((page) => [page.title, page.id]),
    );
    const copiedSecond = await book.load(rows.get("Zweite")!);

    expect(copiedSecond.doc.getMap("properties").get("rel")).toBe(
      [rows.get("Erste"), rows.get("Zweite"), outside].join(","),
    );
  });

  it("duplicates attachments instead of sharing the stored file", async () => {
    const book = await Notebook.create("Notizbuch");
    const root = book.add("Mit Anhang");
    const file = crypto.randomUUID();

    core.files.set(file, Buffer.from("PDFDATA").toString("base64"));
    root.doc
      .getMap("files")
      .set(file, { type: "application/pdf", name: "a.pdf", size: 7 });
    write(root, [
      { type: "file", props: { url: "kladde-file:" + file, name: "a.pdf" } },
    ]);
    const copy = await copyPages(book, book, root.id, false);
    const [reference] = references(await book.load(copy));
    const copiedFile = reference.replace("kladde-file:", "");

    expect(copiedFile).not.toBe(file);
    expect(Buffer.from(core.files.get(copiedFile)!, "base64").toString()).toBe(
      "PDFDATA",
    );
    expect(
      (await book.load(copy)).doc.getMap("files").get(copiedFile),
    ).toMatchObject({ name: "a.pdf" });
  });
});

describe("moving pages to another notebook", () => {
  it("archives the originals and keeps titles and creation dates", async () => {
    const source = await Notebook.create("Quelle");
    const target = await Notebook.create("Ziel");
    const root = source.add("Umzug", "page", source.add("Eltern").id);
    const child = source.add("Kind", "page", root.id);

    source.pages.set(root.id, { ...source.pages.get(root.id)!, created: 1000 });
    const moved = await copyPages(source, target, root.id, true);

    expect(target.pages.get(moved)).toMatchObject({
      title: "Umzug",
      parent: null,
      created: 1000,
    });
    expect(childrenOf(target, moved).map((page) => page.title)).toEqual([
      "Kind",
    ]);
    expect(source.pages.get(root.id)?.archived).not.toBeNull();
    expect(source.pages.get(child.id)?.archived).not.toBeNull();
  });

  it("rolls the copies back and keeps the originals when copying fails", async () => {
    const source = await Notebook.create("Quelle");
    const target = await Notebook.create("Ziel");
    const root = source.add("Umzug");
    const file = crypto.randomUUID();

    core.files.set(file, "eA==");
    root.doc
      .getMap("files")
      .set(file, { type: "text/plain", name: "a.txt", size: 1 });
    core.unreadable = true;

    await expect(copyPages(source, target, root.id, true)).rejects.toThrow(
      "File missing",
    );
    expect([...target.pages.values()].every((page) => page.archived)).toBe(
      true,
    );
    expect(source.pages.get(root.id)?.archived).toBeNull();
  });
});

describe("refusing to copy", () => {
  it("rejects missing, archived, workspace and chat pages without creating anything", async () => {
    const book = await Notebook.create("Notizbuch");
    const archived = book.add("Archiv");

    await book.change(archived.id, { archived: Date.now() });
    const refused = [
      crypto.randomUUID(),
      archived.id,
      book.add("Arbeitsbereich", "workspace").id,
      book.add("Gespräch", "chat").id,
    ];
    const before = book.pages.size;

    for (const id of refused)
      await expect(copyPages(book, book, id, false)).rejects.toThrow(
        "Invalid page",
      );
    expect(book.pages.size).toBe(before);
  });

  it("stops on a cyclic page tree before creating anything", async () => {
    const book = await Notebook.create("Notizbuch");
    const root = book.add("A");
    const child = book.add("B", "page", root.id);

    book.pages.set(root.id, { ...book.pages.get(root.id)!, parent: child.id });
    const before = book.pages.size;

    await expect(copyPages(book, book, root.id, false)).rejects.toThrow(
      "Cyclic page tree",
    );
    expect(book.pages.size).toBe(before);
  });
});
