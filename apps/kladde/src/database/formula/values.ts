import { FormulaError } from "./errors";

const MAX_TEXT = 8192;

export interface RowRef {
  row: string;
  db: string;
  title: string;
}
export type Value = number | string | boolean | null | RowRef | Value[];

export function isRow(value: Value | undefined): value is RowRef {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface FormulaScope {
  prop: (name: string) => Value;
  title: () => string;
  today: string;
  lang?: string;
  rowProp?: (row: RowRef, name: string) => Value;
}

export function cleanNumber(value: number) {
  if (!Number.isFinite(value)) throw new FormulaError("notNumber");

  return Number(value.toFixed(10));
}

export function toNumber(value: Value): number {
  if (value === null) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value !== "string") throw new FormulaError("notNumber");
  if (!value.trim()) return 0;
  const number = Number(value.trim());

  if (!Number.isFinite(number)) throw new FormulaError("notNumber", value);

  return number;
}

export function toText(value: Value): string {
  if (value === null) return "";
  if (typeof value === "number") return String(cleanNumber(value));
  if (Array.isArray(value)) return value.map(toText).join(", ");
  if (isRow(value)) return value.title;

  return String(value);
}

export function truthy(value: Value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRow(value)) return true;

  return value !== "" && value !== "false";
}

export function limitText(text: string) {
  if (text.length > MAX_TEXT) throw new FormulaError("tooComplex");

  return text;
}

function numeric(value: Value) {
  if (typeof value === "number") return true;

  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value))
  );
}

export function compare(left: Value, right: Value) {
  if (
    (typeof left === "number" || typeof right === "number") &&
    numeric(left ?? "") &&
    numeric(right ?? "")
  )
    return toNumber(left) - toNumber(right);
  const a = toText(left),
    b = toText(right);

  return a < b ? -1 : a > b ? 1 : 0;
}

export function same(left: Value, right: Value): boolean {
  if (isRow(left) && isRow(right)) return left.row === right.row;
  if (typeof left === "boolean" || typeof right === "boolean")
    return truthy(left) === truthy(right);
  if (left === null || right === null) return toText(left) === toText(right);

  return compare(left, right) === 0;
}

export function rowOf(value: Value | undefined) {
  if (!isRow(value)) throw new FormulaError("arguments", "row");

  return value;
}

export function round(value: Value, digits: Value = 0) {
  const places = Math.trunc(toNumber(digits));

  if (places < 0 || places > 10) throw new FormulaError("arguments");
  const factor = 10 ** places;

  return Math.round(toNumber(value) * factor) / factor;
}

export function storedValue(value: Value) {
  if (typeof value === "boolean") return value ? "true" : "false";

  return limitText(toText(value));
}
