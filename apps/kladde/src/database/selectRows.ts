import { matchesRule, localDate } from "./rules";
import { compareValues } from "./compute";
import {
  type Field,
  type Row,
  type Rule,
  type SortKey,
  type View,
} from "./types";

const TINT_LIMIT = 12;

function timestampOf(row: Row, field: Field | undefined) {
  if (field?.type === "created") return row.created;
  if (field?.type === "edited") return row.edited;

  return undefined;
}

function compareRows(
  a: Row,
  b: Row,
  key: SortKey,
  field: Field | undefined,
  collator: Intl.Collator,
) {
  const left = timestampOf(a, field),
    right = timestampOf(b, field);

  if (left !== undefined && right !== undefined) return left - right;

  return compareValues(
    cellText(a, key.field),
    cellText(b, key.field),
    field,
    collator,
  );
}

function cellText(row: Row, field: string) {
  return field ? (row.values[field] ?? "") : row.title;
}

function sortsLast(row: Row, key: SortKey, field: Field | undefined) {
  if (field?.type === "checkbox" || timestampOf(row, field) !== undefined)
    return false;

  return cellText(row, key.field) === "";
}

export function selectRows(
  rows: Row[],
  view: View,
  query: string,
  schema: Field[],
) {
  const today = localDate();
  const byId = new Map(schema.map((f) => [f.id, f]));
  const groups = [view, ...(view.groups ?? [])].filter((g) => g.filters.length);
  const term = query.toLocaleLowerCase();
  const visible = rows.filter((r) => {
    if (
      term &&
      ![r.title, ...Object.values(r.values)].some((v) =>
        v.toLocaleLowerCase().includes(term),
      )
    )
      return false;

    const groupMatches = (g: { filters: Rule[]; match: string }) => {
      const check = (rule: Rule) =>
        matchesRule(r, rule, byId.get(rule.field), today);

      return g.match === "any" ? g.filters.some(check) : g.filters.every(check);
    };

    return (
      !groups.length ||
      (view.groupMatch === "any"
        ? groups.some(groupMatches)
        : groups.every(groupMatches))
    );
  });
  const sortKeys = [
    { field: view.sort, descending: view.descending },
    ...(view.thenSort ?? []),
  ];
  const collator = new Intl.Collator(undefined, { numeric: true });

  return visible.sort((a, b) => {
    for (const key of sortKeys) {
      const field = byId.get(key.field);
      const blank =
        Number(sortsLast(a, key, field)) - Number(sortsLast(b, key, field));

      if (blank) return blank;
      const diff = compareRows(a, b, key, field, collator);

      if (diff) return key.descending ? -diff : diff;
    }

    return (a.created ?? 0) - (b.created ?? 0);
  });
}
export function rowTint(
  row: Row,
  view: View,
  schema: { get: (id: string) => Field | undefined },
  today: string,
) {
  for (const tint of (view.tints ?? []).slice(0, TINT_LIMIT)) {
    if (!Array.isArray(tint?.filters) || !tint.filters.length) continue;
    const check = (rule: Rule) =>
      matchesRule(row, rule, schema.get(rule.field), today);
    const hit =
      tint.match === "any"
        ? tint.filters.some(check)
        : tint.filters.every(check);

    if (hit && Number.isInteger(tint.color)) return tint.color % 9;
  }

  return undefined;
}

export function summarize(rows: Row[], summary: NonNullable<View["summary"]>) {
  if (summary.calculation === "count") return rows.length;
  let total = 0,
    count = 0,
    min = Infinity,
    max = -Infinity;

  for (const row of rows) {
    const raw = row.values[summary.field];

    if (!raw?.trim()) continue;
    const value = Number(raw);

    if (!Number.isFinite(value)) continue;
    total += value;
    count++;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  if (!count) return null;

  switch (summary.calculation) {
    case "sum":
      return total;
    case "average":
      return total / count;
    case "maximum":
      return max;
    case "minimum":
      return min;
    default:
      return null;
  }
}
