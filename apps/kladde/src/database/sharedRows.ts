import {
  computeRows,
  splitList,
  type ComputeScope,
  type Related,
} from "./compute";
import { computeScope } from "./computedRows";
import { fields } from "./fields";
import { rowIndex } from "./rowIndex";
import { type Field, type Row } from "./types";
import type { Notebook } from "../notebook/notebook";

type Hidden = (id: string) => boolean;

function withoutHiddenLinks(row: Row, relations: Field[], hidden: Hidden) {
  let values = row.values;

  for (const field of relations) {
    const linked = splitList(row.values[field.id] ?? "");

    if (!linked.some(hidden)) continue;
    if (values === row.values) values = { ...row.values };
    values[field.id] = linked.filter((id) => !hidden(id)).join(",");
  }

  return values === row.values ? row : { ...row, values };
}

export function visibleLinks(row: Row, schema: Field[], hidden: Hidden) {
  return withoutHiddenLinks(
    row,
    schema.filter((field) => field.type === "relation"),
    hidden,
  );
}

export function visibleTitles(book: Notebook, hidden: Hidden): ComputeScope {
  const open = computeScope(book);

  return {
    ...open,
    pageTitle: (id) => (hidden(id) ? "" : open.pageTitle(id)),
  };
}

export function sharedRows(rows: Row[], schema: Field[], hidden: Hidden) {
  const relations = schema.filter((field) => field.type === "relation");

  return rows
    .filter((row) => !hidden(row.id))
    .map((row) => withoutHiddenLinks(row, relations, hidden));
}

function linkedDatabases(book: Notebook, schema: Field[], hidden: Hidden) {
  const computed = schema.some(
    (field) => field.type === "rollup" || field.type === "formula",
  );

  if (!computed) return [];
  const targets = schema.flatMap((field) =>
    field.type === "relation" && field.target ? [field.target] : [],
  );

  return [...new Set(targets)].filter(
    (id) => !hidden(id) && book.pages.get(id)?.kind === "database",
  );
}

export async function sharedScope(
  book: Notebook,
  schema: Field[],
  hidden: Hidden,
): Promise<ComputeScope> {
  const plain = visibleTitles(book, hidden);
  const related = new Map<string, Related>();

  for (const target of linkedDatabases(book, schema, hidden)) {
    const database = await book.load(target);
    const linked = Array.from(fields(database).values());
    const stored = await rowIndex(book, database);
    const rows = computeRows(
      sharedRows(stored, linked, hidden),
      linked.filter((field) => field.type !== "rollup"),
      plain,
    );

    related.set(target, {
      schema: linked,
      rows: new Map(rows.map((row) => [row.id, row])),
    });
  }

  return { ...plain, related };
}
