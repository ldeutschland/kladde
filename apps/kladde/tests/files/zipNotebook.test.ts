import { describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";

interface SavedNote {
  id: string;
  kind: string;
  title: string;
  parent: string | null;
  archived: boolean;
  props: string;
}

const core = vi.hoisted(() => ({ notes: new Map<string, SavedNote>() }));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "load_state") return new ArrayBuffer(0);
    if (name === "save")
      for (const note of args.notes as SavedNote[])
        core.notes.set(note.id, note);
    if (name === "rows" || name === "rows_changed")
      return [
        [...core.notes.values()]
          .filter(
            (note) =>
              note.kind === "row" &&
              note.parent === args.parent &&
              !note.archived,
          )
          .map((note) => [note.id, note.title, note.props]),
        null,
        1,
      ];

    return undefined;
  }),
}));

vi.mock("../../src/notebook/content", async (importOriginal) =>
  (await import("../support/plainContent")).plainContent(
    await importOriginal(),
  ),
);

const { Notebook } = await import("../../src/notebook/notebook");
const { writeMarkdown, markdown } = await import("../../src/notebook/content");
const { addView, fields, newField } = await import("../../src/database/fields");
const { zipNotebook } = await import("../../src/files/zipNotebook");
const { importFiles } = await import("../../src/files/importFiles");

type Book = Awaited<ReturnType<typeof Notebook.create>>;

const MAX_NAME = 120 + "-".length + 36 + ".csv".length;

function page(book: Book, title: string, text: string) {
  const entry = book.add(title);

  writeMarkdown(entry, text);

  return entry;
}

function database(book: Book, title: string, rows: [string, string][]) {
  const db = book.add(title, "database");
  const status = newField(db, "Status", "text");

  addView(db, "Table", "table");

  for (const [name, value] of rows) {
    const row = book.add(name, "row", db.id);

    db.doc.getArray<string>("row_order").push([row.id]);
    row.doc.getMap("properties").set(status, value);
  }

  return db;
}

async function unpacked(book: Book) {
  const files = unzipSync(await zipNotebook(book));

  return Object.fromEntries(
    Object.entries(files).map(([name, data]) => [name, strFromU8(data)]),
  );
}

describe("exporting a notebook as zip", () => {
  it("writes pages and row bodies as markdown and databases as CSV, without archived or chat pages", async () => {
    const book = await Notebook.create("Notizbuch");
    const note = page(book, "Plan", "Erster Absatz\n\nZweiter Absatz");
    const db = database(book, "Aufgaben", [["Einkaufen", "offen"]]);
    const [row] = db.doc.getArray<string>("row_order").toArray();
    const gone = page(book, "Alt", "weg");
    const chat = book.add("Gespräch", "chat");

    await book.change(gone.id, { archived: Date.now() });
    const files = await unpacked(book);

    expect(Object.keys(files).sort()).toEqual([
      `Aufgaben-${db.id}.csv`,
      `Einkaufen-${row}.md`,
      `Plan-${note.id}.md`,
    ]);
    expect(files[`Plan-${note.id}.md`]).toBe("Erster Absatz\n\nZweiter Absatz");
    expect(files[`Aufgaben-${db.id}.csv`].split(/\r?\n/)).toEqual([
      "Title,Status",
      "Einkaufen,offen",
    ]);
    expect(Object.keys(files).join()).not.toContain(chat.id);
  });

  it("turns hostile titles into flat, bounded entry names", async () => {
    const book = await Notebook.create("Notizbuch");
    const titles = [
      "../../etc/passwd",
      "/abs",
      "C:\\Windows\\x",
      "a\0b",
      "x".repeat(200),
    ];
    const ids = titles.map((title) => page(book, title, "x").id);
    const names = Object.keys(await unpacked(book));

    expect(names).toHaveLength(titles.length);

    for (const name of names) {
      expect(name).not.toMatch(/[/\\\0:]|\.\./);
      expect(name.length).toBeLessThanOrEqual(MAX_NAME);
    }

    expect(names).toContain(`______etc_passwd-${ids[0]}.md`);
    expect(names).toContain(`${"x".repeat(120)}-${ids[4]}.md`);
  });

  it("keeps pages with the same title apart", async () => {
    const book = await Notebook.create("Notizbuch");

    page(book, "Gleich", "eins");
    page(book, "Gleich", "zwei");
    const files = await unpacked(book);

    expect(Object.values(files).sort()).toEqual(["eins", "zwei"]);
  });

  it("neutralises spreadsheet formulas in exported tables", async () => {
    const book = await Notebook.create("Notizbuch");

    database(book, "Daten", [
      ['=HYPERLINK("http://x")', "+1"],
      ["@SUM(A1)", "-2"],
    ]);
    const [table] = Object.values(await unpacked(book));
    const lines = table.split(/\r?\n/).slice(1);

    expect(lines).toEqual([
      `"'=HYPERLINK(""http://x"")","'+1"`,
      `"'@SUM(A1)","'-2"`,
    ]);
  });
});

describe("importing an exported notebook again", () => {
  it("restores page text and table rows from the unpacked export", async () => {
    const source = await Notebook.create("Quelle");

    page(source, "Plan", "Erster Absatz\n\nZweiter Absatz");
    database(source, "Aufgaben", [
      ["Einkaufen", "offen"],
      ["Putzen, gründlich", "erledigt"],
    ]);
    const exported = unzipSync(await zipNotebook(source));
    const files = Object.entries(exported).map(([name, data]) => {
      const file = new File([data as Uint8Array<ArrayBuffer>], name);

      Object.defineProperty(file, "webkitRelativePath", { value: "" });

      return file;
    });
    const target = await Notebook.create("Ziel");

    await importFiles(target, files);
    const imported = [...target.pages.values()];
    const plan = imported.find(
      (p) => p.kind === "page" && p.title.startsWith("Plan"),
    )!;
    const db = imported.find((p) => p.kind === "database")!;
    const dbEntry = await target.load(db.id);
    const [status] = [...fields(dbEntry).values()];
    const rows = await Promise.all(
      dbEntry.doc
        .getArray<string>("row_order")
        .toArray()
        .map(async (id) => [
          target.pages.get(id)!.title,
          (await target.load(id)).doc.getMap("properties").get(status.id),
        ]),
    );

    expect(markdown(await target.load(plan.id))).toBe(
      "Erster Absatz\n\nZweiter Absatz",
    );
    expect(status.name).toBe("Status");
    expect(rows).toEqual([
      ["Einkaufen", "offen"],
      ["Putzen, gründlich", "erledigt"],
    ]);
  });
});
