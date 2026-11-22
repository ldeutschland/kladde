import Papa from "papaparse";
import { type FieldType } from "../database/types";

const PARENTHESIZED = /\s?\(([^()\s]*)\)/g;
const NOTION_ADDRESS = /^https?:\/\/(?:www\.)?notion\.so\//i;
const ENCODED_SPACE = "%20";
const PAGE_ID = /[0-9a-f]{32}/i;
const NUMBER = /^-?\d+(?:\.\d+)?$/;
const URL_VALUE = /^https?:\/\/\S+$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GERMAN_DATE =
  /^(\d{1,2})\. (\p{L}+) (\d{4})(?: \d{1,2}:\d{2})?(?: \(.+\))?$/u;
const ENGLISH_DATE =
  /^(\p{L}+) (\d{1,2}), (\d{4})(?: \d{1,2}:\d{2}(?: ?[AP]M)?)?(?: \(.+\))?$/iu;
const ISO_DATE = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T]\d{1,2}:\d{2}.*)?$/;
const RANGE = " → ";
const MAX_OPTION_LENGTH = 60;
const MAX_SELECT_OPTIONS = 25;
const MAX_MULTI_OPTIONS = 200;
const MAX_VALUE_LENGTH = 8192;
const MIN_RECURRING_SHARE = 0.4;
const STATUS_WORDS = new Set([
  "nicht begonnen",
  "in bearbeitung",
  "in arbeit",
  "erledigt",
  "not started",
  "in progress",
  "done",
]);
const MONTHS = [
  ["januar", "january", "jänner"],
  ["februar", "february"],
  ["märz", "march"],
  ["april"],
  ["mai", "may"],
  ["juni", "june"],
  ["juli", "july"],
  ["august"],
  ["september"],
  ["oktober", "october"],
  ["november"],
  ["dezember", "december"],
];

export interface Table {
  header: string[];
  rows: string[][];
}

export interface Column {
  name: string;
  type: FieldType;
  options: string[];
  target: string;
}

export function parseTable(text: string): Table {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const parsed = Papa.parse<string[]>(normalized, {
    skipEmptyLines: "greedy",
    newline: "\n",
  });

  if (parsed.errors.some((e) => e.type === "Quotes"))
    throw Error("Invalid CSV");
  const [header = [], ...rows] = parsed.data;

  return {
    header,
    rows: rows.map((row) => header.map((_, i) => row[i] ?? "")),
  };
}

function idAfter(text: string, start: number) {
  return text.slice(start).match(PAGE_ID)?.[0].toLowerCase() ?? null;
}

function mentionId(target: string) {
  const address = target.match(NOTION_ADDRESS);

  if (address) return idAfter(target, address[0].length);
  const first = target.indexOf(ENCODED_SPACE);

  if (first < 0) return null;
  const last = target.lastIndexOf(ENCODED_SPACE);

  return (
    idAfter(target, last + ENCODED_SPACE.length) ??
    idAfter(target, first + ENCODED_SPACE.length)
  );
}

export function mentionIds(raw: string) {
  return Array.from(raw.matchAll(PARENTHESIZED), (m) => mentionId(m[1])).filter(
    (id): id is string => id !== null,
  );
}

export function withoutMentions(raw: string) {
  return raw
    .replace(PARENTHESIZED, (whole, target: string) =>
      mentionId(target) ? "" : whole,
    )
    .trim();
}

export function rowKey(title: string) {
  const key = withoutMentions(title)
    .replace(/@(?=\S)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();

  return ["unbenannt", "untitled", "ohne titel"].includes(key) ? "" : key;
}

function monthNumber(name: string) {
  const lower = name.toLocaleLowerCase();
  const index = MONTHS.findIndex((names) => names.includes(lower));

  return index < 0 ? 0 : index + 1;
}

function isoDay(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));

  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return null;

  return date.toISOString().slice(0, 10);
}

function singleDate(raw: string) {
  const text = raw.trim();
  const german = GERMAN_DATE.exec(text);

  if (german) return isoDay(+german[3], monthNumber(german[2]), +german[1]);
  const english = ENGLISH_DATE.exec(text);

  if (english) return isoDay(+english[3], monthNumber(english[1]), +english[2]);
  const iso = ISO_DATE.exec(text);

  return iso ? isoDay(+iso[1], +iso[2], +iso[3]) : null;
}

export function notionDate(raw: string) {
  const parts = raw.split(RANGE).map(singleDate);

  if (parts.length > 2 || parts.some((part) => !part)) return null;
  if (parts.length === 1 || parts[0] === parts[1]) return parts[0];

  return parts[1]! < parts[0]! ? null : parts.join("/");
}

function relationTarget(
  values: string[],
  databaseOfRow: (notionId: string) => string | undefined,
) {
  const targets = new Set<string>();

  for (const value of values) {
    const ids = mentionIds(value);

    if (ids.length !== 1) return "";
    const database = databaseOfRow(ids[0]);

    if (!database) return "";
    targets.add(database);
  }

  return targets.size === 1 ? [...targets][0] : "";
}

function isOption(piece: string) {
  const open = piece.split("(").length;

  return (
    piece.length > 0 &&
    piece.length <= MAX_OPTION_LENGTH &&
    !/[,\n]/.test(piece) &&
    open === piece.split(")").length
  );
}

function multiOptions(values: string[]) {
  const pieces = values.map((value) => new Set(value.split(", ")));

  if (pieces.every((set) => set.size === 1)) return null;
  const uses = new Map<string, number>();

  for (const set of pieces)
    for (const piece of set) uses.set(piece, (uses.get(piece) ?? 0) + 1);
  const options = [...uses.keys()];
  const recurring = options.filter((option) => uses.get(option)! > 1).length;

  if (!options.every(isOption) || options.length > MAX_MULTI_OPTIONS)
    return null;

  return recurring >= options.length * MIN_RECURRING_SHARE ? options : null;
}

function isStatus(name: string, options: string[]) {
  return (
    /status/i.test(name) ||
    options.every((o) => STATUS_WORDS.has(o.toLocaleLowerCase()))
  );
}

function singleOptions(values: string[], name: string) {
  if (!values.every(isOption)) return null;
  const options = [...new Set(values)];
  const repeats = options.length < values.length || isStatus(name, options);

  return options.length <= MAX_SELECT_OPTIONS && repeats ? options : null;
}

function choiceColumn(name: string, values: string[]): Column | null {
  const multi = multiOptions(values);

  if (multi) return { name, type: "multi", options: multi, target: "" };
  const single = singleOptions(values, name);

  if (!single) return null;
  const type = isStatus(name, single) ? "status" : "select";

  return { name, type, options: single, target: "" };
}

function simpleType(values: string[]): FieldType | null {
  if (values.every((v) => v === "Yes" || v === "No")) return "checkbox";
  if (values.every((v) => NUMBER.test(v))) return "number";
  if (values.every((v) => notionDate(v))) return "date";
  if (values.every((v) => URL_VALUE.test(v) && !v.includes(", http")))
    return "url";
  if (values.every((v) => EMAIL.test(v))) return "email";

  return null;
}

export function inferColumn(
  name: string,
  raw: string[],
  databaseOfRow: (notionId: string) => string | undefined,
): Column {
  const values = raw.map((v) => v.trim()).filter(Boolean);
  const text: Column = { name, type: "text", options: [], target: "" };

  if (!values.length) return text;
  const target = relationTarget(values, databaseOfRow);

  if (target) return { ...text, type: "relation", target };
  const type = simpleType(values);

  if (type) return { ...text, type };

  return choiceColumn(name, values.map(withoutMentions)) ?? text;
}

export function convertValue(
  column: Column,
  raw: string,
  rowId: (notionId: string) => string | undefined,
) {
  const value = raw.trim();

  if (!value || value.startsWith("data:")) return "";
  if (column.type === "checkbox") return value === "Yes" ? "true" : "false";
  if (column.type === "date") return notionDate(value) ?? "";
  if (column.type === "relation")
    return rowId(mentionIds(value)[0] ?? "") ?? "";

  return withoutMentions(value).slice(0, MAX_VALUE_LENGTH);
}
