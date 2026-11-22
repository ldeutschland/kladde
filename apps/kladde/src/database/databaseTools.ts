import type { Notebook } from "../notebook/notebook";
import {
  calculations,
  evaluateFor,
  type Calculation,
  type ComputeScope,
} from "./compute";
import {
  dateFormats,
  numberFormats,
  readOnlyTypes,
  type DateFormat,
  type Field,
  type FieldType,
  type NumberFormat,
  type Row,
  type Rule,
} from "./types";
import { FormulaError } from "./formula/errors";
import { FORMULA_LENGTH, compile } from "./formula/parser";
import { functionNames } from "./formula/functions";
import { storedValue } from "./formula/values";
import {
  actionKinds,
  needsValue,
  operators,
  stepError,
  STEP_LIMIT,
  type ActionKind,
  type Automation,
  type AutomationStep,
} from "./rules";

type Arg = Record<string, unknown>;

const NAME_LENGTH = 100;
const VALUE_LENGTH = 8192;
const FILTER_LIMIT = 32;
const PREVIEW_ROWS = 3;
const BAR_LIMIT = 1e12;
const PREFIX_PATTERN = /^[A-Za-z0-9]{0,10}$/;
const TRIGGERS: Automation["trigger"][] = ["create", "change", "manual"];
const STRUCTURAL: FormulaError["code"][] = [
  "syntax",
  "unknownFunction",
  "unknownName",
  "unknownProperty",
  "arguments",
  "cycle",
  "tooComplex",
];
const configTypes: Record<string, FieldType[]> = {
  format: ["number", "formula", "rollup"],
  bar: ["number", "formula", "rollup"],
  bar_max: ["number", "formula", "rollup"],
  date_format: ["date", "created", "edited", "rollup"],
  relation: ["rollup"],
  property: ["rollup"],
  rollup: ["rollup"],
  prefix: ["autoId"],
  rule: ["button"],
};

export interface FormulaPreview {
  property: string;
  results: { row: string; value: string }[];
}

export interface ConfigContext {
  schema: Field[];
  rules: Automation[];
  targetSchema: (database: string) => Promise<Field[]>;
}

function text(value: unknown, label: string, limit = VALUE_LENGTH) {
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value !== "string" || value.length > limit)
    throw Error(label + " must be text up to " + limit + " characters");

  return value;
}

function flag(value: unknown, label: string) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw Error(label + " must be true or false");
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
) {
  if (typeof value === "string" && allowed.includes(value as T))
    return value as T;
  throw Error(label + " must be one of: " + allowed.join(", "));
}

function names(schema: Field[]) {
  return schema.map((f) => '"' + f.name + '"').join(", ") || "none";
}

export function findField(schema: Field[], ref: unknown, label = "property") {
  const key = text(ref, label, 200).trim();
  const lower = key.toLocaleLowerCase();
  const field =
    schema.find((f) => f.id === key) ??
    schema.find((f) => f.name.toLocaleLowerCase() === lower);

  if (!field)
    throw Error(
      "Unknown " +
        label +
        " " +
        JSON.stringify(key) +
        ". Properties: " +
        names(schema),
    );

  return field;
}

function findRule(rules: Automation[], ref: unknown) {
  const key = text(ref, "rule", 200).trim();
  const rule =
    rules.find((r) => r.id === key) ??
    rules.find((r) => r.name.toLocaleLowerCase() === key.toLocaleLowerCase());

  if (!rule || rule.trigger !== "manual")
    throw Error(
      "rule must name an automation with trigger manual. Manual automations: " +
        (rules
          .filter((r) => r.trigger === "manual")
          .map((r) => '"' + r.name + '"')
          .join(", ") || "none"),
    );

  return rule.id;
}

function barMax(value: unknown) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0 || number >= BAR_LIMIT)
    throw Error("bar_max must be a positive number");

  return number;
}

function prefix(value: unknown) {
  const raw = text(value, "prefix", 10);

  if (!PREFIX_PATTERN.test(raw))
    throw Error("prefix allows up to 10 letters or digits");

  return raw.toUpperCase();
}

async function rollupProperty(
  value: unknown,
  relation: Field | undefined,
  context: ConfigContext,
) {
  if (!relation?.target) throw Error("property needs relation first");
  if (value === "") return "";
  const target = await context.targetSchema(relation.target);

  return findField(
    target.filter((f) => f.type !== "rollup" && f.type !== "button"),
    value,
    "property of the related database",
  ).id;
}

function checkKeys(config: Arg, type: FieldType) {
  for (const key of Object.keys(config)) {
    const allowed = configTypes[key];

    if (!allowed)
      throw Error(
        "Unknown config key " +
          key +
          ". Keys: " +
          Object.keys(configTypes).join(", "),
      );
    if (!allowed.includes(type))
      throw Error(
        key + " applies only to " + allowed.join(", ") + " properties",
      );
  }
}

export async function fieldConfig(
  raw: unknown,
  field: Pick<Field, "type" | "relation">,
  context: ConfigContext,
): Promise<Partial<Field>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw))
    throw Error("config must be an object");
  const config = raw as Arg;

  checkKeys(config, field.type);
  const result: Partial<Field> = {};

  if ("format" in config)
    result.format = oneOf<NumberFormat>(config.format, numberFormats, "format");
  if ("bar" in config) result.bar = flag(config.bar, "bar");
  if ("bar_max" in config) result.barMax = barMax(config.bar_max);
  if ("date_format" in config)
    result.dateFormat = oneOf<DateFormat>(
      config.date_format,
      dateFormats,
      "date_format",
    );
  if ("rollup" in config)
    result.rollup = oneOf<Calculation>(config.rollup, calculations, "rollup");
  if ("prefix" in config) result.prefix = prefix(config.prefix);
  if ("rule" in config) result.rule = findRule(context.rules, config.rule);

  if ("relation" in config) {
    const relation = findField(context.schema, config.relation, "relation");

    if (relation.type !== "relation")
      throw Error("relation must name a relation property");
    result.relation = relation.id;
  }

  if ("property" in config) {
    const relation = context.schema.find(
      (f) => f.id === (result.relation ?? field.relation),
    );

    result.property = await rollupProperty(config.property, relation, context);
  }

  return result;
}

export function formulaSource(value: unknown) {
  const source = text(value, "formula", FORMULA_LENGTH);

  try {
    compile(source);
  } catch (error) {
    throw Error(formulaMessage(error, []), { cause: error });
  }

  return source;
}

export function formulaMessage(error: unknown, schema: Field[]) {
  if (!(error instanceof FormulaError)) return String(error);
  const detail = error.detail;

  switch (error.code) {
    case "syntax":
      return "Syntax error" + (detail ? " near " + JSON.stringify(detail) : "");
    case "unknownFunction":
      return (
        "Unknown function " +
        detail +
        ". Functions: " +
        functionNames.join(", ")
      );
    case "unknownName":
      return (
        "Unknown name " +
        detail +
        '. Use prop("Name") for properties, quotes for text, let(...) for variables, current inside map or filter'
      );
    case "unknownProperty":
      return (
        "Unknown property " +
        JSON.stringify(detail) +
        ". Properties: " +
        names(schema)
      );
    case "arguments":
      return "Wrong arguments for " + detail;
    case "notNumber":
      return "Not a number: " + JSON.stringify(detail);
    case "notDate":
      return "Not a date (expected YYYY-MM-DD): " + JSON.stringify(detail);
    case "cycle":
      return "The formula refers to itself through " + detail;
    default:
      return "Formula too long or too complex (2000 characters, 1000 list items, 20000 steps)";
  }
}

export function checkFormula(
  source: string,
  label: string,
  schema: Field[],
  rows: Row[],
  scope: ComputeScope,
): FormulaPreview {
  const samples = rows.length
    ? rows.slice(0, PREVIEW_ROWS)
    : [{ id: "", title: "", values: {} }];
  const results = samples.map((row) => {
    try {
      return {
        row: row.title,
        value: storedValue(evaluateFor(source, row, schema, scope)),
      };
    } catch (error) {
      if (error instanceof FormulaError && STRUCTURAL.includes(error.code))
        throw Error(
          "Formula error in " + label + ": " + formulaMessage(error, schema),
          { cause: error },
        );

      return {
        row: row.title,
        value: "error: " + formulaMessage(error, schema),
      };
    }
  });

  return { property: label, results: rows.length ? results : [] };
}

function filterFrom(raw: unknown, schema: Field[], index: number): Rule {
  if (!raw || typeof raw !== "object")
    throw Error("Filter " + index + " must be an object");
  const item = raw as Arg;
  const field = item.field ? findField(schema, item.field) : undefined;
  const ops = operators(field?.type);
  const op = item.op === undefined ? ops[0] : text(item.op, "op", 32);

  if (!ops.includes(op))
    throw Error(
      "Filter " +
        index +
        ": op for " +
        (field?.name ?? "title") +
        " must be one of: " +
        ops.join(", "),
    );
  const value = item.value === undefined ? "" : text(item.value, "value", 2000);

  if (needsValue(op) && !value.trim())
    throw Error("Filter " + index + ": " + op + " needs a value");
  const rule: Rule = { field: field?.id ?? "", op, value };

  if (op === "between") rule.end = text(item.end ?? "", "end", 2000);

  return rule;
}

function stepFrom(
  raw: unknown,
  schema: Field[],
  book: Notebook,
  index: number,
) {
  if (!raw || typeof raw !== "object")
    throw Error("Action " + index + " must be an object");
  const item = raw as Arg;
  const target = findField(schema, item.field);

  if (readOnlyTypes.includes(target.type))
    throw Error(
      "Action " +
        index +
        ": " +
        target.name +
        " is " +
        target.type +
        " and cannot be changed",
    );
  const action = oneOf<ActionKind>(
    item.action,
    actionKinds,
    "Action " + index + " action",
  );
  let value = item.value === undefined ? "" : text(item.value, "value");

  if (action === "copy") value = findField(schema, value, "source property").id;
  const step: AutomationStep = { field: target.id, action, value };
  const problem = stepError(step, target, schema, book);

  if (problem)
    throw Error(
      "Action " + index + " (" + target.name + ", " + action + ") " + problem,
    );
  if (action === "formula") formulaSource(value);

  return step;
}

function list(value: unknown, label: string, limit: number) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > limit)
    throw Error(label + " must be a list of at most " + limit + " items");

  return value;
}

export function automationFrom(
  input: Arg,
  schema: Field[],
  book: Notebook,
  existing?: Automation,
): Automation {
  const name =
    input.name === undefined
      ? existing?.name
      : text(input.name, "name", NAME_LENGTH).trim();

  if (!name) throw Error("name is required for a new automation");
  const trigger =
    input.trigger === undefined
      ? (existing?.trigger ?? "create")
      : oneOf(input.trigger, TRIGGERS, "trigger");
  const watch =
    trigger !== "change"
      ? ""
      : input.watch === undefined
        ? (existing?.watch ?? "")
        : input.watch === ""
          ? ""
          : findField(schema, input.watch, "watch property").id;
  const match =
    input.match === undefined
      ? (existing?.match ?? "all")
      : oneOf(input.match, ["all", "any"] as const, "match");
  const rawFilters = list(input.filters, "filters", FILTER_LIMIT);
  const filters = rawFilters
    ? rawFilters.map((f, i) => filterFrom(f, schema, i + 1))
    : (existing?.filters ?? []);
  const rawActions = list(input.actions, "actions", STEP_LIMIT);
  const actions = rawActions
    ? rawActions.map((step, i) => stepFrom(step, schema, book, i + 1))
    : (existing?.actions ?? []);

  if (!actions.length) throw Error("actions needs at least one step");
  const enabled =
    input.enabled === undefined
      ? (existing?.enabled ?? true)
      : flag(input.enabled, "enabled");

  return {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    enabled,
    trigger,
    watch,
    filters,
    match,
    ...actions[0],
    actions,
  };
}
