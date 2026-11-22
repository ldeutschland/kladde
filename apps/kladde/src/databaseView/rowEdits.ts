import type { Dispatch, SetStateAction } from "react";
import type { Entry, Notebook } from "../notebook/notebook";
import { type Field, type Row } from "../database/types";
import { applyAutomations, assignFreshIds } from "../database/rules";
import { copyPages } from "../notebook/copyPages";
import { tryValue } from "./Cell";

export interface RowStore {
  book: Notebook;
  db: Entry;
  setRows: Dispatch<SetStateAction<Row[]>>;
}

export function isRow(store: RowStore, id: string) {
  return store.book.pages.get(id)?.parent === store.db.id;
}

export async function createRow(
  store: RowStore,
  groupField: Field | undefined,
  value: string,
) {
  const { book, db } = store;
  const row = book.add("", "row", db.id);

  db.doc.getArray<string>("row_order").push([row.id]);

  if (value && groupField) {
    const valid = tryValue(groupField, value, book);

    if (valid !== null) row.doc.getMap("properties").set(groupField.id, valid);
  }

  await book.flush();

  return row.id;
}

export async function storeValue(
  store: RowStore,
  id: string,
  field: Field,
  raw: string,
) {
  const valid = tryValue(field, raw.trim(), store.book);

  if (!isRow(store, id) || valid === null) return false;
  const entry = await store.book.load(id);
  const properties = entry.doc.getMap<string>("properties");

  if ((properties.get(field.id) ?? "") === valid) return true;
  properties.set(field.id, valid);
  store.setRows((list) =>
    list.map((r) =>
      r.id === id ? { ...r, values: { ...r.values, [field.id]: valid } } : r,
    ),
  );

  return true;
}

export async function renameRow(store: RowStore, id: string, raw: string) {
  const title = raw.trim().slice(0, 200);

  if (!isRow(store, id)) return false;
  await store.book.change(id, { title });
  store.setRows((list) => list.map((r) => (r.id === id ? { ...r, title } : r)));

  return true;
}

export async function trashRow(store: RowStore, id: string) {
  if (!isRow(store, id)) return;
  await store.book.trashBranch(id, Date.now());
  store.setRows((list) => list.filter((r) => r.id !== id));
}

export async function duplicateRow(store: RowStore, id: string) {
  const { book, db } = store;

  if (!isRow(store, id)) return;
  const copy = await copyPages(book, book, id, false);

  db.doc.getArray<string>("row_order").push([copy]);
  assignFreshIds(db, await book.load(copy));
  await book.flush();
}

export async function runRule(
  book: Notebook,
  db: Entry,
  entry: Entry,
  title: string,
  field: Field,
) {
  if (!field.rule) return;
  applyAutomations(book, db, entry, title, "manual", new Set(), field.rule);
  await book.flush();
}

export async function runRowButton(store: RowStore, row: Row, field: Field) {
  if (!field.rule || !isRow(store, row.id)) return;
  const entry = await store.book.load(row.id);

  await runRule(store.book, store.db, entry, row.title, field);
}
