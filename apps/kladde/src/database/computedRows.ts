import { type Entry, type Notebook } from "../notebook/notebook";
import { localDate } from "./rules";
import { computeRows, type ComputeScope, type Related } from "./compute";
import { type Field, type Row } from "./types";
import { fields } from "./fields";
import { rowCache, rowIndex, type RowSnapshot } from "./rowIndex";

export function computeScope(
  book: Notebook,
  related: Map<string, Related> = new Map(),
): ComputeScope {
  return {
    pageTitle: (id) => book.pages.get(id)?.title ?? "",
    related,
    today: localDate(),
    lang: typeof document === "undefined" ? "" : document.documentElement.lang,
  };
}

async function relatedRows(book: Notebook, schema: Field[]) {
  const related = new Map<string, Related>();
  const computed = schema.some(
    (f) => f.type === "rollup" || f.type === "formula",
  );
  const targets = new Set(
    schema
      .filter((f) => computed && f.type === "relation")
      .map((f) => f.target)
      .filter(
        (id): id is string => !!id && book.pages.get(id)?.kind === "database",
      ),
  );

  for (const target of targets)
    related.set(target, await relatedTo(book, await book.load(target)));

  return related;
}

async function relatedTo(book: Notebook, entry: Entry): Promise<Related> {
  const schema = Array.from(fields(entry).values());
  const raw = await rowIndex(book, entry);
  const cache = rowCache(book, entry.id);
  const key = [
    cache.version,
    book.pages.version,
    JSON.stringify(schema),
  ].join();

  if (cache.related?.key === key) return cache.related.value;
  const rows = computeRows(
    raw,
    schema.filter((f) => f.type !== "rollup"),
    computeScope(book),
  );
  const value = { schema, rows: new Map(rows.map((r) => [r.id, r])) };

  cache.related = { key, value };

  return value;
}

export async function rowScope(book: Notebook, db: Entry) {
  return computeScope(
    book,
    await relatedRows(book, Array.from(fields(db).values())),
  );
}
export async function rowSnapshot(
  book: Notebook,
  db: Entry,
  progress?: (rows: Row[]) => void,
): Promise<RowSnapshot> {
  const schema = Array.from(fields(db).values());
  const scope = await rowScope(book, db);
  const raw = await rowIndex(book, db, progress);
  const cache = rowCache(book, db.id);
  const computed = schema.some(
    (f) => f.type === "rollup" || f.type === "formula",
  );
  const linked = [...scope.related.keys()].map(
    (id) => rowCache(book, id).version,
  );
  const key = [
    db.id,
    cache.version,
    linked.join(),
    computed ? book.pages.version : 0,
    scope.today,
    JSON.stringify(schema),
  ].join("|");

  if (cache.shown?.key !== key)
    cache.shown = { key, scope, rows: computeRows(raw, schema, scope) };

  return cache.shown;
}
export async function computedRows(book: Notebook, db: Entry) {
  return (await rowSnapshot(book, db)).rows;
}
