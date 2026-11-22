import type { Entry, Notebook } from "../notebook/notebook";
import { type Field, type FieldType, type Rule, type Row } from "./types";
import { computeScope } from "./computedRows";
import { fields } from "./fields";
import { validValue } from "./validValue";
import {
  computeRows,
  evaluateFor,
  isNumeric,
  splitList,
  type ComputeScope,
} from "./compute";
import { visibleLinks, visibleTitles } from "./sharedRows";
import { storedValue } from "./formula/values";

const textOps = [
  "contains",
  "notContains",
  "equals",
  "notEquals",
  "startsWith",
  "endsWith",
];
const comparison = [
  "equals",
  "notEquals",
  "less",
  "atMost",
  "greater",
  "atLeast",
  "between",
];
const dates = [
  "equals",
  "beforeDate",
  "afterDate",
  "between",
  "today",
  "pastDays",
  "nextDays",
  "thisWeek",
  "thisMonth",
  "thisYear",
];
const computed = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "less",
  "atMost",
  "greater",
  "atLeast",
  "between",
  "checked",
  "unchecked",
];
const numericOps = new Set(comparison);
const noValueOps = new Set([
  "emptyValue",
  "filledValue",
  "checked",
  "unchecked",
  "today",
  "thisWeek",
  "thisMonth",
  "thisYear",
]);

export function needsValue(op: string) {
  return !noValueOps.has(op);
}
export function operators(type: FieldType = "text") {
  let ops = textOps;

  if (type === "number" || type === "autoId") ops = comparison;
  if (["date", "created", "edited"].includes(type)) ops = dates;
  if (["status", "select", "relation"].includes(type))
    ops = ["equals", "notEquals"];
  if (type === "multi") ops = ["hasOption", "lacksOption"];
  if (type === "formula" || type === "rollup") ops = computed;
  if (type === "checkbox") return ["checked", "unchecked"];
  if (type === "button") return [];

  return [...ops, "emptyValue", "filledValue"];
}

export function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");

  return y + "-" + m + "-" + String(date.getDate()).padStart(2, "0");
}

function period(op: string, today: string) {
  const now = new Date(today + "T00:00:00Z");
  const start = new Date(now);
  const end = new Date(now);

  if (op === "thisWeek") {
    start.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    end.setTime(start.getTime() + 6 * 86400000);
  } else if (op === "thisMonth") {
    start.setUTCDate(1);
    end.setUTCMonth(now.getUTCMonth() + 1, 0);
  } else {
    start.setUTCMonth(0, 1);
    end.setUTCMonth(11, 31);
  }

  return [start.getTime() / 86400000, end.getTime() / 86400000];
}

function numericRule(field: Field | undefined, op: string, raw: string) {
  if (!field || !numericOps.has(op)) return false;
  if (field.type === "number" || field.type === "autoId") return true;

  return (
    (field.type === "formula" || field.type === "rollup") && isNumeric(raw)
  );
}

function day(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(value);

  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== value
  )
    return NaN;

  return time / 86400000;
}

const DATE_FIELDS = ["date", "created", "edited"];
const PERIODS = ["thisWeek", "thisMonth", "thisYear"];
const RELATION_OPS = ["equals", "notEquals"];
const MAX_RELATIVE_DAYS = 3650;

function invalidRule(rule: Rule, field?: Field) {
  return (
    !rule ||
    typeof rule.field !== "string" ||
    typeof rule.value !== "string" ||
    (rule.op !== undefined && !!rule.field && !field)
  );
}

function presenceMatch(op: string, raw: string) {
  if (op === "emptyValue") return !raw;
  if (op === "filledValue") return !!raw;
  if (op === "checked") return raw === "true";
  if (op === "unchecked") return !raw || raw === "false";

  return undefined;
}

function relativeMatch(
  op: string,
  [start, end]: number[],
  now: number,
  term: string,
) {
  const days = Number(term);

  if (!Number.isInteger(days) || days < 1 || days > MAX_RELATIVE_DAYS)
    return false;
  if (op === "pastDays") return start <= now && end > now - days;

  return start < now + days && end >= now;
}

function dateMatch(
  op: string,
  rule: Rule,
  raw: string,
  term: string,
  today: string,
) {
  const [first, last = first] = raw.split("/");
  const start = day(first);
  const end = day(last);
  const target = day(term);
  const now = day(today);

  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (op === "today") return start <= now && end >= now;

  if (PERIODS.includes(op)) {
    const [from, until] = period(op, today);

    return start <= until && end >= from;
  }

  if (op === "beforeDate") return end < target;
  if (op === "afterDate") return start > target;
  if (op === "equals") return start <= target && end >= target;

  if (op === "between") {
    const until = day(rule.end ?? "");

    return target <= until && start <= until && end >= target;
  }

  return relativeMatch(op, [start, end], now, term);
}

function relationMatch(op: string, raw: string, value: string) {
  const linked = splitList(raw).includes(value);

  return op === "equals" ? linked : !linked;
}

function betweenNumbers(actual: number, low: number, high = "") {
  return (
    !!high.trim() &&
    Number.isFinite(Number(high)) &&
    actual >= low &&
    actual <= Number(high)
  );
}

function numberMatch(op: string, rule: Rule, raw: string, term: string) {
  const actual = Number(raw);
  const expected = Number(term);

  if (!term.trim() || !Number.isFinite(actual) || !Number.isFinite(expected))
    return false;

  switch (op) {
    case "equals":
      return actual === expected;
    case "notEquals":
      return actual !== expected;
    case "greater":
      return actual > expected;
    case "atLeast":
      return actual >= expected;
    case "less":
      return actual < expected;
    case "atMost":
      return actual <= expected;
    case "between":
      return betweenNumbers(actual, expected, rule.end);
    default:
      return undefined;
  }
}

function optionMatch(op: string, raw: string, value: string) {
  const options = raw.split(",").map((option) => option.trim());

  if (op === "hasOption") return options.some((option) => option === value);

  return options.every((option) => option !== value);
}

function textMatch(op: string, rule: Rule, raw: string, term: string) {
  const value = raw.toLowerCase();

  if (!term) return false;

  switch (op) {
    case "contains":
      return value.includes(term);
    case "notContains":
      return !value.includes(term);
    case "equals":
      return value === term;
    case "notEquals":
      return value !== term;
    case "startsWith":
      return value.startsWith(term);
    case "endsWith":
      return value.endsWith(term);
    case "hasOption":
    case "lacksOption":
      return optionMatch(op, raw, rule.value);
    default:
      return false;
  }
}

function typedMatch(
  op: string,
  rule: Rule,
  field: Field | undefined,
  raw: string,
  today: string,
) {
  const term = rule.value.toLowerCase();

  if (field && DATE_FIELDS.includes(field.type))
    return dateMatch(op, rule, raw, term, today);
  if (field?.type === "relation" && RELATION_OPS.includes(op))
    return relationMatch(op, raw, rule.value);

  if (numericRule(field, op, raw)) {
    const matched = numberMatch(op, rule, raw, term);

    if (matched !== undefined) return matched;
  }

  return textMatch(op, rule, raw, term);
}

export function matchesRule(
  row: Row,
  rule: Rule,
  field?: Field,
  today = localDate(),
) {
  if (invalidRule(rule, field)) return false;
  const raw = rule.field ? (row.values[rule.field] ?? "") : row.title;

  if (typeof raw !== "string") return false;
  if (rule.op === undefined)
    return raw.toLowerCase().includes(rule.value.toLowerCase());
  if (!operators(field?.type).includes(rule.op)) return false;
  const presence = presenceMatch(rule.op, raw);

  if (presence !== undefined) return presence;
  if (!raw) return false;

  return typedMatch(rule.op, rule, field, raw, today);
}

export const actionKinds = [
  "set",
  "clear",
  "stamp",
  "copy",
  "dateOffset",
  "increment",
  "toggle",
  "append",
  "addOption",
  "removeOption",
  "formula",
] as const;
export type ActionKind = (typeof actionKinds)[number];

export interface AutomationStep {
  field: string;
  action: ActionKind;
  value: string;
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  trigger: "create" | "change" | "manual";
  watch: string;
  filters: Rule[];
  match: "all" | "any";
  field: string;
  action: ActionKind;
  value: string;
  actions?: AutomationStep[];
}

type FieldLookup = { get: (id: string) => Field | undefined };

export const STEP_LIMIT = 16;
const FILTER_LIMIT = 32;
const VALUE_LIMIT = 8192;
const OFFSET_LIMIT = 3650;
const TEXT_TYPES: FieldType[] = ["text", "url", "email", "phone", "person"];
const LOCKED_TYPES: FieldType[] = [
  "created",
  "edited",
  "formula",
  "rollup",
  "autoId",
  "button",
];

export function automations(db: Entry) {
  return db.doc.getMap<Automation>("automations");
}

export function counters(db: Entry) {
  return db.doc.getMap<number>("counters");
}

export function writableField(field: Field | undefined): field is Field {
  return !!field && !LOCKED_TYPES.includes(field.type);
}

export function actionsFor(type: FieldType | undefined): ActionKind[] {
  if (!type) return [];
  const base: ActionKind[] = ["set", "clear", "copy", "formula"];

  if (type === "date") return [...base, "stamp", "dateOffset"];
  if (type === "number") return [...base, "increment"];
  if (type === "checkbox") return [...base, "toggle"];
  if (type === "multi") return [...base, "addOption", "removeOption"];
  if (TEXT_TYPES.includes(type)) return [...base, "append"];

  return base;
}

export function automationSteps(rule: Automation): AutomationStep[] {
  const steps =
    Array.isArray(rule.actions) && rule.actions.length
      ? rule.actions
      : [{ field: rule.field, action: rule.action, value: rule.value }];

  return steps
    .slice(0, STEP_LIMIT)
    .filter(
      (step) =>
        !!step &&
        typeof step.field === "string" &&
        typeof step.value === "string" &&
        step.value.length <= VALUE_LIMIT &&
        actionKinds.includes(step.action),
    );
}

function invalidNumber(action: ActionKind, value: string) {
  const number = Number(value);

  if (!value.trim() || !Number.isFinite(number)) return "expects a number";
  if (
    action === "dateOffset" &&
    (!Number.isInteger(number) || Math.abs(number) > OFFSET_LIMIT)
  )
    return "expects whole days between -3650 and 3650";

  return "";
}

function invalidSetValue(target: Field, value: string, book: Notebook) {
  if (!value) return "needs a value; use clear to empty the property";

  try {
    validValue(target, value, book);

    return "";
  } catch (error) {
    return String(error instanceof Error ? error.message : error);
  }
}

export function stepError(
  step: AutomationStep,
  target: Field,
  schema: Field[],
  book: Notebook,
) {
  const value = step.value;

  if (!actionsFor(target.type).includes(step.action))
    return (
      "allows only " +
      actionsFor(target.type).join(", ") +
      " for " +
      target.type
    );

  if (step.action === "copy") {
    if (value === target.id) return "cannot copy a property onto itself";

    return schema.some((f) => f.id === value)
      ? ""
      : "copies an unknown property";
  }

  if (step.action === "dateOffset" || step.action === "increment")
    return invalidNumber(step.action, value);
  if (step.action === "addOption" || step.action === "removeOption")
    return target.options.includes(value)
      ? ""
      : "expects one of the options " + target.options.join(", ");
  if (step.action === "formula") return value.trim() ? "" : "needs a formula";
  if (step.action === "set") return invalidSetValue(target, value, book);
  if (step.action === "append") return value ? "" : "needs text to append";

  return "";
}

function nextCounter(db: Entry, fieldId: string) {
  const store = counters(db);
  const current = Number(store.get(fieldId));
  const next = (Number.isSafeInteger(current) && current > 0 ? current : 0) + 1;

  store.set(fieldId, next);

  return String(next);
}

function autoIdFields(db: Entry) {
  return Array.from(fields(db).values()).filter((f) => f.type === "autoId");
}

export function assignFreshIds(db: Entry, entry: Entry) {
  const props = entry.doc.getMap<string>("properties");

  entry.doc.transact(() => {
    for (const field of autoIdFields(db))
      props.set(field.id, nextCounter(db, field.id));
  }, "automation");
}

export async function numberRows(book: Notebook, db: Entry, fieldId: string) {
  const pages = Array.from(book.pages.values())
    .filter((p) => p.parent === db.id && p.kind === "row" && !p.archived)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  let next = 0;

  for (const page of pages) {
    const entry = await book.load(page.id);

    next++;
    entry.doc.transact(
      () => entry.doc.getMap("properties").set(fieldId, String(next)),
      "automation",
    );
  }

  counters(db).set(fieldId, next);
  await book.flush();
}

function runsFor(
  rule: Automation,
  trigger: Automation["trigger"],
  changed: Set<string>,
  only?: string,
) {
  if (!rule || rule.enabled !== true || rule.trigger !== trigger) return false;
  if (only && rule.id !== only) return false;
  if (trigger === "change" && rule.watch && !changed.has(rule.watch))
    return false;

  return (
    Array.isArray(rule.filters) &&
    rule.filters.length <= FILTER_LIMIT &&
    ["any", "all"].includes(rule.match)
  );
}

function filtersMatch(
  rule: Automation,
  row: Row,
  schema: FieldLookup,
  today: string,
) {
  const matches = rule.filters.map((f) =>
    matchesRule(row, f, schema.get(f?.field), today),
  );

  if (!matches.length) return true;

  return rule.match === "all" ? matches.every(Boolean) : matches.some(Boolean);
}

function offsetDate(raw: string) {
  const days = Number(raw);

  if (!raw.trim() || !Number.isInteger(days) || Math.abs(days) > OFFSET_LIMIT)
    return null;
  const date = new Date();

  date.setDate(date.getDate() + days);

  return localDate(date);
}

function incremented(current: string, raw: string) {
  const step = Number(raw);
  const base = current.trim() ? Number(current) : 0;

  if (!raw.trim() || !Number.isFinite(step) || !Number.isFinite(base))
    return null;

  return String(Number((base + step).toFixed(10)));
}

function withOption(current: string, option: string, add: boolean) {
  const chosen = splitList(current).filter((v) => v !== option);

  return (add ? [...chosen, option] : chosen).join(",");
}

interface StepContext {
  row: Row;
  computed: Row;
  schema: Field[];
  book: Notebook;
  scope: ComputeScope;
  today: string;
}

type Hidden = (id: string) => boolean;

function stepValue(step: AutomationStep, field: Field, context: StepContext) {
  const current = context.row.values[field.id] ?? "";

  switch (step.action) {
    case "set":
      return step.value;
    case "clear":
      return "";
    case "stamp":
      return field.type === "date" ? context.today : null;
    case "dateOffset":
      return field.type === "date" ? offsetDate(step.value) : null;
    case "copy":
      if (step.value === field.id) return null;
      if (!context.schema.some((f) => f.id === step.value)) return null;

      return context.computed.values[step.value] ?? "";
    case "increment":
      return incremented(current, step.value);
    case "toggle":
      return current === "true" ? "false" : "true";
    case "append":
      return current ? current + " " + step.value : step.value;
    case "addOption":
    case "removeOption":
      return withOption(current, step.value, step.action === "addOption");
    case "formula":
      return storedValue(
        evaluateFor(
          step.value,
          context.computed,
          context.schema,
          context.scope,
        ),
      );
  }

  return null;
}

function withoutHidden(field: Field, value: string, hidden?: Hidden) {
  if (!hidden || field.type !== "relation") return value;

  return splitList(value)
    .filter((id) => !hidden(id))
    .join(",");
}

export function applyAutomations(
  book: Notebook,
  db: Entry,
  entry: Entry,
  title: string,
  trigger: Automation["trigger"],
  changed: Set<string>,
  only?: string,
  hidden?: Hidden,
) {
  const props = entry.doc.getMap<string>("properties");
  const row: Row = { id: entry.id, title, values: props.toJSON() };
  const schema = fields(db);
  const list = Array.from(schema.values());
  const today = localDate();
  const scope = hidden ? visibleTitles(book, hidden) : computeScope(book);
  const visible = () => (hidden ? visibleLinks(row, list, hidden) : row);
  const updates = new Map<string, string>();

  if (trigger === "create")
    for (const field of autoIdFields(db))
      if (!row.values[field.id]) {
        row.values[field.id] = nextCounter(db, field.id);
        updates.set(field.id, row.values[field.id]);
      }

  for (const rule of automations(db).values()) {
    if (!runsFor(rule, trigger, changed, only)) continue;
    const computed = computeRows([visible()], list, scope)[0];

    if (!filtersMatch(rule, computed, schema, today)) continue;

    for (const step of automationSteps(rule)) {
      const field = schema.get(step.field);

      if (!writableField(field)) continue;
      const context = { row, computed, schema: list, book, scope, today };

      try {
        const raw = stepValue(step, field, context);

        if (raw === null) continue;
        const value = withoutHidden(
          field,
          validValue(field, raw, book),
          hidden,
        );

        updates.set(field.id, value);
        row.values[field.id] = value;
      } catch {
        continue;
      }
    }
  }

  entry.doc.transact(() => {
    for (const [id, value] of updates) {
      if ((props.get(id) ?? "") !== value) props.set(id, value);
    }
  }, "automation");
}
