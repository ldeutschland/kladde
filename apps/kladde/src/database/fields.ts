import { type Entry } from "../notebook/notebook";
import type * as Y from "yjs";
import { calculations } from "./compute";
import {
  dateFormats,
  numberFormats,
  types,
  type Field,
  type FieldType,
  type Layout,
  type View,
} from "./types";

const FIELD_LIMIT = 100;
const OPTION_LIMIT = 500;
const KEY_LIMIT = 200;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const FIELD_TEXT = [
  "target",
  "formula",
  "relation",
  "property",
  "prefix",
  "rule",
] as const;
const FIELD_FLAGS = ["bar"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= KEY_LIMIT &&
    !UNSAFE_KEYS.has(key)
  );
}

function oneOf<T extends string>(list: readonly T[], value: unknown) {
  return list.includes(value as T) ? (value as T) : undefined;
}

function picked(
  raw: Record<string, unknown>,
  keys: readonly string[],
  kind: "string" | "boolean",
) {
  const chosen = keys.filter((key) => typeof raw[key] === kind);

  return Object.fromEntries(chosen.map((key) => [key, raw[key]]));
}

function cleanOptions(raw: unknown) {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((option): option is string => typeof option === "string")
    .slice(0, OPTION_LIMIT);
}

function chosenValues(raw: Record<string, unknown>) {
  const values = {
    format: oneOf(numberFormats, raw.format),
    dateFormat: oneOf(dateFormats, raw.dateFormat),
    rollup: oneOf(calculations, raw.rollup),
    barMax: Number.isFinite(raw.barMax) ? raw.barMax : undefined,
  };

  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

function cleanField(id: string, raw: unknown): Field | undefined {
  if (!safeKey(id) || !isRecord(raw) || raw.id !== id) return undefined;
  const type = oneOf(types, raw.type);

  if (!type || typeof raw.name !== "string") return undefined;

  return {
    ...(picked(raw, FIELD_TEXT, "string") as Partial<Field>),
    ...(picked(raw, FIELD_FLAGS, "boolean") as Partial<Field>),
    ...(chosenValues(raw) as Partial<Field>),
    id,
    name: raw.name,
    type,
    options: cleanOptions(raw.options),
  };
}

function cleanFields(schema: Y.Map<unknown>) {
  const clean = new Map<string, Field>();

  for (const [id, raw] of schema.entries()) {
    if (clean.size >= FIELD_LIMIT) break;
    const field = cleanField(id, raw);

    if (field) clean.set(id, field);
  }

  return clean;
}

export function fields(e: Entry) {
  const schema = e.doc.getMap<unknown>("schema");
  const all = () => cleanFields(schema);

  return {
    get: (id: string) => cleanField(id, schema.get(id)),
    has: (id: string) => cleanField(id, schema.get(id)) !== undefined,
    keys: () => all().keys(),
    values: () => all().values(),
    get size() {
      return all().size;
    },
    toJSON: () => Object.fromEntries(all()),
    set: (id: string, field: Field) => schema.set(id, field),
    delete: (id: string) => schema.delete(id),
  };
}
export function rowValues(json: string) {
  const parsed: unknown = JSON.parse(json);
  const values: Record<string, string> = Object.create(null);

  if (!isRecord(parsed)) return values;
  for (const [key, value] of Object.entries(parsed))
    if (safeKey(key) && typeof value === "string") values[key] = value;

  return values;
}
export function views(e: Entry) {
  return e.doc.getMap<View>("views");
}
export function addView(e: Entry, name: string, type: Layout) {
  const id = crypto.randomUUID();
  const view: View = {
    id,
    name,
    type,
    filters: [],
    match: "all",
    sort: "",
    descending: false,
    group: "",
    visible: null,
    widths: {},
  };

  views(e).set(id, view);

  return view;
}

const FIELD_NAME_LENGTH = 200;

export function validFieldName(name: string) {
  return !!name.trim() && name.length <= FIELD_NAME_LENGTH;
}

export function newField(
  e: Entry,
  name: string,
  type: FieldType,
  options: string[] = [],
  target?: string,
  extra: Partial<Field> = {},
) {
  if (!validFieldName(name) || !types.includes(type) || fields(e).size >= 100)
    throw Error("Invalid property");
  const id = crypto.randomUUID();

  fields(e).set(id, { ...extra, id, name, type, options, target });

  return id;
}
