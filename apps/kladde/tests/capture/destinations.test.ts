import { describe, expect, it, vi } from "vitest";
import type { T } from "../../src/locale/locale";

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async () => undefined),
}));

const { Notebook } = await import("../../src/notebook/notebook");
const { newField } = await import("../../src/database/fields");
const {
  QUICK_NOTES,
  WEB_CLIPS,
  addRow,
  chooseDestination,
  destination,
  destinationTitle,
  fieldNamed,
  openDatabases,
  quickNotesDatabase,
} = await import("../../src/capture/destinations");

const t = ((key: string) => key) as T;

async function bookWithDatabase() {
  const book = await Notebook.create("Notizbuch");
  const db = book.add("Eingang", "database");

  return { book, db };
}

describe("capture destinations", () => {
  it("ignores stored settings that do not point at an open database", async () => {
    const { book, db } = await bookWithDatabase();
    const page = book.add("Seite");
    const archived = book.add("Alt", "database");

    await book.change(archived.id, { archived: 1 });
    const hostile: unknown[] = [
      "not an object",
      [db.id],
      { database: 42 },
      { database: { id: db.id } },
      { database: page.id },
      { database: archived.id },
      { database: "missing" },
      null,
    ];

    for (const value of hostile) {
      book.settings.set(QUICK_NOTES, value);
      expect(destination(book, QUICK_NOTES)).toBeNull();
    }

    book.settings.set(QUICK_NOTES, { database: db.id });
    expect(destination(book, QUICK_NOTES)).toBe(db.id);
    expect(destination(book, WEB_CLIPS)).toBeNull();
  });

  it("only accepts open databases as a destination", async () => {
    const { book, db } = await bookWithDatabase();
    const page = book.add("Seite");

    expect(() => chooseDestination(book, WEB_CLIPS, page.id)).toThrow(
      "Invalid database",
    );
    expect(() => chooseDestination(book, WEB_CLIPS, "missing")).toThrow();
    chooseDestination(book, WEB_CLIPS, db.id);
    expect(destination(book, WEB_CLIPS)).toBe(db.id);
    expect(openDatabases(book).map((item) => item.id)).toEqual([db.id]);
  });

  it("does not rewrite the setting when the same database is chosen again", async () => {
    const { book, db } = await bookWithDatabase();
    const writes = vi.fn();

    chooseDestination(book, WEB_CLIPS, db.id);
    book.settings.observe(writes);
    chooseDestination(book, WEB_CLIPS, db.id);
    expect(writes).not.toHaveBeenCalled();
  });

  it("creates the quick notes database once and reuses it", async () => {
    const book = await Notebook.create("Notizbuch");
    const first = await quickNotesDatabase(book, t);
    const second = await quickNotesDatabase(book, t);

    expect(second.id).toBe(first.id);
    expect(book.pages.get(first.id)?.kind).toBe("database");
    expect(destinationTitle(book, QUICK_NOTES, t)).toBe("quickNotes");
  });

  it("creates a new quick notes database when the chosen one was trashed", async () => {
    const book = await Notebook.create("Notizbuch");
    const first = await quickNotesDatabase(book, t);

    await book.change(first.id, { archived: 1 });
    const replacement = await quickNotesDatabase(book, t);

    expect(replacement.id).not.toBe(first.id);
  });

  it("names the destination after the database or falls back per kind", async () => {
    const { book, db } = await bookWithDatabase();

    expect(destinationTitle(book, WEB_CLIPS, t)).toBe("webClips");
    expect(destinationTitle(book, QUICK_NOTES, t)).toBe("quickNotes");
    chooseDestination(book, WEB_CLIPS, db.id);
    expect(destinationTitle(book, WEB_CLIPS, t)).toBe("Eingang");
    await book.change(db.id, { title: "" });
    expect(destinationTitle(book, WEB_CLIPS, t)).toBe("untitled");
  });

  it("appends rows to the database order", async () => {
    const { book, db } = await bookWithDatabase();
    const first = addRow(book, db, "eins");
    const second = addRow(book, db, "zwei", "fixed-id");

    expect(second.id).toBe("fixed-id");
    expect(db.doc.getArray("row_order").toArray()).toEqual([
      first.id,
      "fixed-id",
    ]);
    expect(book.pages.get(first.id)).toMatchObject({
      kind: "row",
      parent: db.id,
    });
  });

  it("finds a field by trimmed, case-insensitive name and matching type", async () => {
    const { db } = await bookWithDatabase();
    const url = newField(db, "  Web Adresse ", "url");

    newField(db, "Quelle", "text");
    expect(fieldNamed(db, "web adresse", "url")).toBe(url);
    expect(fieldNamed(db, "WEB ADRESSE  ", "url")).toBe(url);
    expect(fieldNamed(db, "web adresse", "text")).toBeUndefined();
    expect(fieldNamed(db, "quelle", "url")).toBeUndefined();
  });
});
