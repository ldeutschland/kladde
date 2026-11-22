import {
  type DateFormat,
  type Field,
  type FieldType,
  type NumberFormat,
  type Row,
} from "./types";
import { FormulaError } from "./formula/errors";
import { parseDay } from "./formula/dates";
import { runFormula } from "./formula/evaluate";
import {
  storedValue,
  type FormulaScope,
  type RowRef,
  type Value,
} from "./formula/values";

export const calculations = [
  "count",
  "countValues",
  "countEmpty",
  "countUnique",
  "percentEmpty",
  "percentFilled",
  "sum",
  "average",
  "median",
  "minimum",
  "maximum",
  "range",
  "earliest",
  "latest",
  "dateRange",
  "checked",
  "unchecked",
  "percentChecked",
  "showValues",
  "showUnique",
] as const;
export type Calculation = (typeof calculations)[number];

const GENERAL: Calculation[] = [
  "count",
  "countValues",
  "countEmpty",
  "countUnique",
  "percentEmpty",
  "percentFilled",
];
const NUMERIC: Calculation[] = [
  "sum",
  "average",
  "median",
  "minimum",
  "maximum",
  "range",
];
const DATES: Calculation[] = ["earliest", "latest", "dateRange"];
const CHECKS: Calculation[] = ["checked", "unchecked", "percentChecked"];
const LISTS: Calculation[] = ["showValues", "showUnique"];
const PERCENTS: Calculation[] = [
  "percentEmpty",
  "percentFilled",
  "percentChecked",
];
const NUMERIC_TYPES: FieldType[] = ["number", "autoId"];
const COMPUTED_TYPES: FieldType[] = ["formula", "rollup"];
const DATE_TYPES: FieldType[] = ["date", "created", "edited"];
const DAY_MS = 86400000;
const BOOLEAN_TEXT = ["true", "false"];
const CURRENCIES: Partial<Record<NumberFormat, string>> = {
  euro: "EUR",
  dollar: "USD",
  pound: "GBP",
  franc: "CHF",
  yen: "JPY",
};

export interface Related {
  schema: Field[];
  rows: Map<string, Row>;
}

export interface ComputeScope {
  pageTitle: (id: string) => string;
  related: Map<string, Related>;
  today: string;
  lang?: string;
}

export function splitList(raw: string) {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function isNumeric(raw: string) {
  return raw.trim() !== "" && Number.isFinite(Number(raw));
}

export function numericField(field: Field | undefined) {
  return (
    !!field &&
    (NUMERIC_TYPES.includes(field.type) || COMPUTED_TYPES.includes(field.type))
  );
}

export function compareValues(
  left: string,
  right: string,
  field: Field | undefined,
  collator: Intl.Collator,
) {
  if (!numericField(field)) return collator.compare(left, right);
  const leftNumeric = isNumeric(left),
    rightNumeric = isNumeric(right);

  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;

  return collator.compare(left, right);
}

export function calculationsFor(type: FieldType | undefined): Calculation[] {
  if (!type) return GENERAL;
  if (type === "checkbox") return ["count", ...CHECKS];
  if (NUMERIC_TYPES.includes(type)) return [...GENERAL, ...NUMERIC];
  if (DATE_TYPES.includes(type)) return [...GENERAL, ...DATES];
  if (COMPUTED_TYPES.includes(type))
    return [...GENERAL, ...NUMERIC, ...DATES, ...CHECKS];
  if (type === "button") return ["count"];

  return GENERAL;
}

export function rollupCalculations(type: FieldType | undefined) {
  return [...calculationsFor(type), ...LISTS];
}

function percent(part: number, total: number) {
  return total ? Math.round((part / total) * 1000) / 10 : null;
}

function numbersOf(values: string[]) {
  return values.filter(isNumeric).map(Number);
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numericCalculation(calc: Calculation, numbers: number[]): Value {
  if (!numbers.length) return null;
  const total = numbers.reduce((sum, n) => sum + n, 0);
  const min = Math.min(...numbers),
    max = Math.max(...numbers);

  if (calc === "sum") return Number(total.toFixed(10));
  if (calc === "average") return Number((total / numbers.length).toFixed(10));
  if (calc === "median") return median(numbers);
  if (calc === "minimum") return min;
  if (calc === "maximum") return max;

  return Number((max - min).toFixed(10));
}

function dateCalculation(calc: Calculation, values: string[]): Value {
  const days = values.filter((v) => /^\d{4}-\d{2}-\d{2}/.test(v));

  if (!days.length) return null;
  const starts = days.map((v) => v.split("/")[0]).sort();
  const ends = days.map((v) => v.split("/").at(-1) ?? v).sort();
  const earliest = starts[0],
    latest = ends[ends.length - 1];

  if (calc === "earliest") return earliest;
  if (calc === "latest") return latest;

  return Math.round(
    (Date.parse(latest + "T00:00:00Z") - Date.parse(earliest + "T00:00:00Z")) /
      DAY_MS,
  );
}

export function calculate(calc: Calculation, values: string[]): Value {
  const filled = values.filter((v) => v.trim() !== "");
  const checked = values.filter((v) => v === "true").length;

  switch (calc) {
    case "count":
      return values.length;
    case "countValues":
      return filled.length;
    case "countEmpty":
      return values.length - filled.length;
    case "countUnique":
      return new Set(filled.flatMap(splitList)).size;
    case "percentEmpty":
      return percent(values.length - filled.length, values.length);
    case "percentFilled":
      return percent(filled.length, values.length);
    case "checked":
      return checked;
    case "unchecked":
      return values.length - checked;
    case "percentChecked":
      return percent(checked, values.length);
    case "showValues":
      return filled.join(", ").slice(0, 8192);
    case "showUnique":
      return [...new Set(filled.flatMap(splitList))].join(", ").slice(0, 8192);
  }

  if (NUMERIC.includes(calc))
    return numericCalculation(calc, numbersOf(filled));
  if (DATES.includes(calc)) return dateCalculation(calc, filled);

  return null;
}

export function isPercent(calc: Calculation | undefined) {
  return !!calc && PERCENTS.includes(calc);
}

function rollupValue(
  field: Field,
  row: Row,
  schema: Field[],
  scope: ComputeScope,
) {
  const relation = schema.find(
    (f) => f.id === field.relation && f.type === "relation",
  );
  const related = relation?.target
    ? scope.related.get(relation.target)
    : undefined;

  if (!relation || !related) return "";
  const targets = splitList(row.values[relation.id] ?? "")
    .map((id) => related.rows.get(id))
    .filter((target): target is Row => !!target);
  const property = field.property
    ? related.schema.find((f) => f.id === field.property)
    : undefined;

  if (field.property && !property) return "";
  const values = targets.map((target) =>
    property
      ? property.type === "relation"
        ? splitList(target.values[property.id] ?? "")
            .map(scope.pageTitle)
            .join(", ")
        : (target.values[property.id] ?? "")
      : target.title,
  );
  const calc = calculations.includes(field.rollup as Calculation)
    ? (field.rollup as Calculation)
    : "showValues";

  try {
    return storedValue(calculate(calc, values));
  } catch {
    return "";
  }
}

function plainValue(field: Field, raw: string, scope: ComputeScope): Value {
  if (field.type === "checkbox") return raw === "true";
  if (numericField(field) && isNumeric(raw)) return Number(raw);
  if (field.type === "formula" && BOOLEAN_TEXT.includes(raw))
    return raw === "true";
  if (field.type === "multi") return splitList(raw);
  if (field.type === "relation")
    return splitList(raw).map((id) => ({
      row: id,
      db: field.target ?? "",
      title: scope.pageTitle(id),
    }));

  return raw === "" ? null : raw;
}

const relatedNames = new WeakMap<Related, Map<string, Field>>();

function relatedField(related: Related, name: string) {
  let byName = relatedNames.get(related);

  if (!byName) {
    byName = fieldsByName(related.schema);
    relatedNames.set(related, byName);
  }

  return byName.get(name.toLocaleLowerCase()) ?? byName.get(name.trim());
}

function linkedValue(scope: ComputeScope, ref: RowRef, name: string) {
  const related = scope.related.get(ref.db);
  const target = related?.rows.get(ref.row);
  const field = related ? relatedField(related, name) : undefined;

  if (!target || !field) throw new FormulaError("unknownProperty", name);

  return plainValue(field, target.values[field.id] ?? "", scope);
}

function fieldsByName(schema: Field[]) {
  const byName = new Map<string, Field>();

  for (const field of schema) {
    byName.set(field.id, field);
    byName.set(field.name.toLocaleLowerCase(), field);
  }

  return byName;
}

function formulaScope(
  row: Row,
  schema: Field[],
  scope: ComputeScope,
  byName = fieldsByName(schema),
) {
  const memo = new Map<string, Value>();
  const visiting = new Set<string>();
  const valueOf = (field: Field): Value => {
    if (field.type !== "formula")
      return plainValue(field, row.values[field.id] ?? "", scope);
    if (memo.has(field.id)) return memo.get(field.id)!;
    if (visiting.has(field.id)) throw new FormulaError("cycle", field.name);
    visiting.add(field.id);

    try {
      const value = runFormula(String(field.formula ?? ""), formula);

      memo.set(field.id, value);

      return value;
    } finally {
      visiting.delete(field.id);
    }
  };
  const formula: FormulaScope = {
    today: scope.today,
    lang: scope.lang,
    title: () => row.title,
    rowProp: (ref, name) => linkedValue(scope, ref, name),
    prop: (name) => {
      const field =
        byName.get(name.toLocaleLowerCase()) ?? byName.get(name.trim());

      if (!field) throw new FormulaError("unknownProperty", name);

      return valueOf(field);
    },
  };

  return { formula, valueOf };
}

export function evaluateFor(
  source: string,
  row: Row,
  schema: Field[],
  scope: ComputeScope,
) {
  return runFormula(source, formulaScope(row, schema, scope).formula);
}

function computeRow(
  row: Row,
  schema: Field[],
  byName: Map<string, Field>,
  scope: ComputeScope,
): Row {
  const values = { ...row.values };

  for (const field of schema)
    if (field.type === "rollup")
      values[field.id] = rollupValue(field, row, schema, scope);
  const withRollups = { ...row, values };
  const { valueOf } = formulaScope(withRollups, schema, scope, byName);

  for (const field of schema) {
    if (field.type !== "formula") continue;

    try {
      values[field.id] = storedValue(valueOf(field));
    } catch {
      values[field.id] = "";
    }
  }

  return withRollups;
}

export function computeRows(rows: Row[], schema: Field[], scope: ComputeScope) {
  if (!schema.some((f) => COMPUTED_TYPES.includes(f.type))) return rows;
  const byName = fieldsByName(schema);

  return rows.map((row) => computeRow(row, schema, byName, scope));
}

const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(format: NumberFormat, lang: string) {
  const key = format + "|" + lang;
  const cached = numberFormatters.get(key);

  if (cached) return cached;
  const currency = CURRENCIES[format];
  let options: Intl.NumberFormatOptions = { maximumFractionDigits: 10 };

  if (format === "integer") options = { maximumFractionDigits: 0 };
  if (format === "decimal")
    options = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  if (format === "percent")
    options = { style: "percent", maximumFractionDigits: 2 };
  if (currency) options = { style: "currency", currency };
  const formatter = new Intl.NumberFormat(lang || undefined, options);

  numberFormatters.set(key, formatter);

  return formatter;
}

export function formatNumber(
  value: number,
  format: NumberFormat | undefined,
  lang: string,
) {
  if (!format || format === "plain") return String(value);

  return numberFormatter(format, lang).format(value);
}

function relativeDay(day: string, today: string, lang: string) {
  const diff = Math.round(
    (Date.parse(day + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) /
      DAY_MS,
  );
  const formatter = new Intl.RelativeTimeFormat(lang || undefined, {
    numeric: "auto",
  });

  if (Math.abs(diff) < 14) return formatter.format(diff, "day");
  if (Math.abs(diff) < 60)
    return formatter.format(Math.round(diff / 7), "week");

  return formatter.format(Math.round(diff / 30), "month");
}

function formatOneDay(
  day: string,
  format: DateFormat,
  lang: string,
  today: string,
) {
  try {
    const date = parseDay(day);

    if (format === "relative") return relativeDay(day, today, lang);
    const options: Intl.DateTimeFormatOptions =
      format === "weekday"
        ? { weekday: "short", day: "numeric", month: "short", year: "numeric" }
        : { dateStyle: format as "short" | "medium" | "long" };

    return new Intl.DateTimeFormat(lang || undefined, {
      ...options,
      timeZone: "UTC",
    }).format(date);
  } catch {
    return day;
  }
}

export function formatDate(
  raw: string,
  format: DateFormat | undefined,
  lang: string,
  today: string,
) {
  if (!raw || !format || format === "iso") return raw.replace("/", " → ");

  return raw
    .split("/")
    .map((day) => formatOneDay(day, format, lang, today))
    .join(" → ");
}

export function displayValue(
  field: Field,
  raw: string,
  lang: string,
  today: string,
) {
  if (!raw) return "";
  if (field.type === "autoId")
    return (field.prefix ? field.prefix + "-" : "") + raw;
  if (field.type === "rollup" && isPercent(field.rollup))
    return formatNumber(Number(raw), undefined, lang) + " %";
  if (DATE_TYPES.includes(field.type))
    return formatDate(
      raw,
      field.dateFormat ?? (field.type === "date" ? "iso" : "medium"),
      lang,
      today,
    );
  if (numericField(field) && isNumeric(raw))
    return formatNumber(Number(raw), field.format, lang);
  if (field.type === "rollup" && /^\d{4}-\d{2}-\d{2}$/.test(raw))
    return formatDate(raw, field.dateFormat, lang, today);

  return raw;
}

export function barRatio(field: Field, raw: string) {
  if (!field.bar || !numericField(field) || !isNumeric(raw)) return null;
  const fallback = field.format === "percent" ? 1 : 100;
  const max =
    Number.isFinite(field.barMax) && (field.barMax ?? 0) > 0
      ? field.barMax!
      : fallback;

  return Math.min(1, Math.max(0, Number(raw) / max));
}
