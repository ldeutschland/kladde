import {
  createdAt,
  type Entry,
  type Notebook,
  type Page,
} from "../notebook/notebook";
import { command } from "../platform/native";
import { localDate } from "./rules";
import { type ComputeScope, type Related } from "./compute";
import { type Field, type Row } from "./types";
import { fields, rowValues } from "./fields";

export type StoredRow = [string, string, string];
type ChangedRow = [string, string, string, boolean];

export type RowPage<T> = [T[], number | null, number];
interface RowCache {
  rows: Map<string, Row>;
  list: Row[];
  mark: number;
  filled: boolean;
  version: number;
  timed: string;
  queue: Promise<void>;
  used: number;
  holders: number;
  related?: { key: string; value: Related };
  shown?: RowSnapshot;
}

export interface RowSnapshot {
  key: string;
  rows: Row[];
  scope: ComputeScope;
}
const ROW_IDLE_MS = 30000;
const rowCaches = new WeakMap<Notebook, Map<string, RowCache>>();
const rowReleases = new WeakMap<Notebook, ReturnType<typeof setTimeout>>();

export function rowCache(book: Notebook, id: string) {
  const caches = rowCaches.get(book) ?? new Map<string, RowCache>();

  rowCaches.set(book, caches);
  const cache = caches.get(id) ?? {
    rows: new Map<string, Row>(),
    list: [],
    mark: 0,
    filled: false,
    version: 0,
    timed: "",
    queue: Promise.resolve(),
    used: Date.now(),
    holders: 0,
  };

  caches.set(id, cache);

  return cache;
}

function rowsInUse(caches: Map<string, RowCache>) {
  const kept = new Set<string>();

  for (const [id, cache] of caches) {
    if (!cache.holders) continue;
    kept.add(id);
    for (const linked of cache.shown?.scope.related.keys() ?? [])
      kept.add(linked);
  }

  return kept;
}

function releaseIdleRows(book: Notebook) {
  const caches = rowCaches.get(book) ?? new Map<string, RowCache>();
  const kept = rowsInUse(caches);
  const idleSince = Date.now() - ROW_IDLE_MS;

  for (const [id, cache] of caches)
    if (!kept.has(id) && cache.used <= idleSince) caches.delete(id);

  return [...caches.keys()].some((id) => !kept.has(id));
}

function releaseRowsLater(book: Notebook) {
  if (rowReleases.has(book)) return;

  const sweep = () => {
    rowReleases.delete(book);
    if (releaseIdleRows(book)) releaseRowsLater(book);
  };

  rowReleases.set(book, setTimeout(sweep, ROW_IDLE_MS));
}

export function retainRows(book: Notebook, id: string) {
  const cache = rowCache(book, id);

  cache.holders++;

  return () => {
    cache.holders--;
    cache.used = Date.now();
    releaseRowsLater(book);
  };
}

function timeFields(schema: Field[]) {
  const timed = schema.filter(
    (f) => f.type === "created" || f.type === "edited",
  );

  return timed.map((f) => f.type + f.id).join();
}

function relist(cache: RowCache) {
  cache.list = [...cache.rows.values()];
  cache.version++;
}

function keepRow(
  book: Notebook,
  cache: RowCache,
  schema: Field[],
  row: StoredRow,
) {
  const [id, title, json] = row;
  const values = rowValues(json);

  cache.rows.set(id, timedRow(id, title, values, book.dated(id), schema));
}

async function fillRows(
  book: Notebook,
  db: Entry,
  cache: RowCache,
  schema: Field[],
  progress?: (rows: Row[]) => void,
) {
  let after: number | null = 0;

  while (after !== null) {
    const page: RowPage<StoredRow> = await command("rows", {
      space: book.id,
      parent: db.id,
      after,
    });

    if (after === 0) cache.mark = page[2];
    for (const row of page[0]) keepRow(book, cache, schema, row);
    relist(cache);
    if (page[1] !== null) progress?.(cache.list);
    after = page[1];
  }

  cache.filled = true;
}

async function catchUpRows(
  book: Notebook,
  db: Entry,
  cache: RowCache,
  schema: Field[],
) {
  let since: number | null = cache.mark;

  while (since !== null) {
    const page: RowPage<ChangedRow> = await command("rows_changed", {
      space: book.id,
      parent: db.id,
      since,
    });

    for (const [id, title, json, gone] of page[0])
      if (gone) cache.rows.delete(id);
      else keepRow(book, cache, schema, [id, title, json]);
    if (page[0].length) relist(cache);
    cache.mark = page[2];
    since = page[1];
  }
}

function restamp(book: Notebook, cache: RowCache, schema: Field[]) {
  const timed = timeFields(schema);

  if (cache.timed === timed) return;
  cache.timed = timed;
  for (const row of cache.rows.values())
    timedRow(row.id, row.title, row.values, book.dated(row.id), schema);
  relist(cache);
}

export function rowIndex(
  book: Notebook,
  db: Entry,
  progress?: (rows: Row[]) => void,
): Promise<Row[]> {
  const cache = rowCache(book, db.id);

  cache.used = Date.now();
  releaseRowsLater(book);

  const refresh = async () => {
    await book.pages.rowsOf(db.id);
    const schema = Array.from(fields(db).values());

    if (cache.filled) await catchUpRows(book, db, cache, schema);
    else await fillRows(book, db, cache, schema, progress);
    restamp(book, cache, schema);

    return cache.list;
  };
  const result = cache.queue.then(refresh, refresh);

  cache.queue = result.then(
    () => {},
    () => {},
  );

  return result;
}
export function timedRow(
  id: string,
  title: string,
  values: Record<string, string>,
  page: Page | undefined,
  schema: Field[],
): Row {
  if (!page) return { id, title, values };
  const created = createdAt(page),
    edited = page.updated;

  for (const f of schema) {
    if (f.type === "created") values[f.id] = localDate(new Date(created));
    if (f.type === "edited") values[f.id] = localDate(new Date(edited));
  }

  return { id, title, values, created, edited };
}
