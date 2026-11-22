import { FormulaError } from "./errors";
import { isRow, toNumber, toText, type Value } from "./values";

export const LIST_LIMIT = 1000;

export function limitList(items: Value[]) {
  if (items.length > LIST_LIMIT) throw new FormulaError("tooComplex");

  return items;
}

export function listItems(value: Value): Value[] {
  if (Array.isArray(value)) return value;
  if (value === null) return [];
  if (isRow(value)) return [value];

  return toText(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function numbers(values: Value[]): number[] {
  return values.flatMap((value) => {
    if (Array.isArray(value)) return numbers(value);
    if (value === null || value === "") return [];
    if (typeof value === "string" && value.includes(","))
      return numbers(listItems(value));

    return [toNumber(value)];
  });
}

function itemKey(value: Value) {
  if (isRow(value)) return "row:" + value.row;

  return typeof value + ":" + toText(value);
}

export function unique(values: Value[]) {
  const seen = new Set<string>();

  return values.filter((value) => {
    const key = itemKey(value);

    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
}

export function flatten(values: Value[]) {
  return limitList(values.flatMap((value) => listItems(value)));
}

export function isEmpty(value: Value) {
  if (value === null) return true;
  if (Array.isArray(value)) return !value.length;

  return typeof value === "string" && !value.trim();
}

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
