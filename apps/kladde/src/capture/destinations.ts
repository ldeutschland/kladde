import { addView, fields, newField, views } from "../database/fields";
import { type FieldType } from "../database/types";
import type { Entry, Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";

export const QUICK_NOTES = "captureDatabase";
export const WEB_CLIPS = "clipDatabase";
export type Destination = typeof QUICK_NOTES | typeof WEB_CLIPS;

function savedDatabase(book: Notebook, key: Destination) {
  const saved = book.settings.get(key);

  if (!saved || typeof saved !== "object") return undefined;
  const id = (saved as Record<string, unknown>).database;

  return typeof id === "string" ? id : undefined;
}

function isOpenDatabase(page: Page | undefined): page is Page {
  return page?.kind === "database" && !page.archived;
}

export function destination(book: Notebook, key: Destination) {
  const id = savedDatabase(book, key);
  const page = id ? book.pages.get(id) : undefined;

  return isOpenDatabase(page) ? page.id : null;
}

export function chooseDestination(
  book: Notebook,
  key: Destination,
  database: string,
) {
  if (!isOpenDatabase(book.pages.get(database)))
    throw Error("Invalid database");
  if (savedDatabase(book, key) === database) return;
  book.settings.set(key, { database });
}

export function openDatabases(book: Notebook) {
  return Array.from(book.pages.values()).filter(isOpenDatabase);
}

function createQuickNotes(book: Notebook, t: T) {
  const db = book.add(t("quickNotes"), "database");
  const created = newField(db, t("created"), "created");
  const view = addView(db, t("list"), "list");

  views(db).set(view.id, { ...view, sort: created, descending: true });
  book.settings.set(QUICK_NOTES, { database: db.id });

  return db;
}

export async function quickNotesDatabase(book: Notebook, t: T): Promise<Entry> {
  const chosen = destination(book, QUICK_NOTES);

  return chosen ? book.load(chosen) : createQuickNotes(book, t);
}

export function destinationTitle(book: Notebook, key: Destination, t: T) {
  const chosen = destination(book, key);
  const fallback = t(key === QUICK_NOTES ? "quickNotes" : "webClips");

  return chosen ? book.pages.get(chosen)?.title || t("untitled") : fallback;
}

export function addRow(book: Notebook, db: Entry, title: string, id?: string) {
  const row = book.add(title, "row", db.id, id);

  db.doc.getArray<string>("row_order").push([row.id]);

  return row;
}

export function fieldNamed(db: Entry, name: string, type: FieldType) {
  const wanted = name.trim().toLocaleLowerCase();

  for (const field of fields(db).values())
    if (field.type === type && field.name.trim().toLocaleLowerCase() === wanted)
      return field.id;

  return undefined;
}
