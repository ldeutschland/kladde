import { splitList } from "../database/compute";
import { fields, views } from "../database/fields";
import { type Field } from "../database/types";
import type { Entry, Notebook, Stored } from "../notebook/notebook";
import type { T } from "../locale/locale";

export interface Fact {
  key: string;
  label: string;
  before: string;
  after: string;
}

interface Named {
  get: (id: string) => { name: string } | undefined;
  keys: () => Iterable<string>;
}

function text(value: unknown) {
  if (value === null || value === undefined) return "";

  return typeof value === "string" ? value : JSON.stringify(value);
}

function readable(book: Notebook, field: Field | undefined, value: string) {
  if (field?.type !== "relation") return value;

  return splitList(value)
    .map((id) => book.pages.get(id)?.title ?? id)
    .join(", ");
}

function titleFact(version: Stored, current: string, t: T): Fact[] {
  if (version.title === current) return [];
  const label = t("title");

  return [{ key: "title", label, before: version.title, after: current }];
}

function propertyFacts(
  book: Notebook,
  old: Entry,
  entry: Entry,
  database: Entry | null,
): Fact[] {
  const before = old.doc.getMap("properties");
  const after = entry.doc.getMap("properties");
  const schema = database ? fields(database) : undefined;
  const keys = new Set([...before.keys(), ...after.keys()]);

  return [...keys].flatMap((key) => {
    const field = schema?.get(key);
    const was = readable(book, field, text(before.get(key)));
    const is = readable(book, field, text(after.get(key)));

    if (was === is) return [];
    const label = field?.name ?? key;

    return [{ key: "property:" + key, label, before: was, after: is }];
  });
}

function namedFacts(kind: string, label: string, before: Named, after: Named) {
  const ids = new Set([...before.keys(), ...after.keys()]);

  return [...ids].flatMap((id): Fact[] => {
    const was = before.get(id)?.name ?? "";
    const is = after.get(id)?.name ?? "";

    if (was === is) return [];

    return [{ key: kind + ":" + id, label, before: was, after: is }];
  });
}

function structureFacts(old: Entry, entry: Entry, t: T) {
  return [
    ...namedFacts("field", t("property"), fields(old), fields(entry)),
    ...namedFacts("view", t("view"), views(old), views(entry)),
  ];
}

export function versionFacts(
  book: Notebook,
  version: Stored,
  old: Entry,
  entry: Entry,
  database: Entry | null,
  t: T,
): Fact[] {
  const title = book.pages.get(entry.id)?.title ?? "";
  const isRow = entry.kind === "row";
  const isDatabase = entry.kind === "database";

  return [
    ...titleFact(version, title, t),
    ...(isRow ? propertyFacts(book, old, entry, database) : []),
    ...(isDatabase ? structureFacts(old, entry, t) : []),
  ];
}
