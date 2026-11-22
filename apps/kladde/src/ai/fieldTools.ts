import type { Entry } from "../notebook/notebook";
import { computeScope } from "../database/computedRows";
import { fields, newField } from "../database/fields";
import { rowIndex } from "../database/rowIndex";
import { types, type Field, type FieldType } from "../database/types";
import { automations } from "../database/rules";
import { computeRows } from "../database/compute";
import { sharedRows, sharedScope } from "../database/sharedRows";
import {
  automationFrom,
  checkFormula,
  fieldConfig,
  findField,
  formulaSource,
  type ConfigContext,
  type FormulaPreview,
} from "../database/databaseTools";
import { listArg, textArg, type ToolArgs } from "./toolArguments";
import type { AgentRun } from "./AgentRun";

const NAME_LENGTH = 200;
const ID_LENGTH = 36;
const MAX_AUTOMATIONS = 32;

function configContext(run: AgentRun, entry: Entry): ConfigContext {
  return {
    schema: Array.from(fields(entry).values()),
    rules: Array.from(automations(entry).values()),
    targetSchema: async (database) => {
      const target = await run.entry(database, false);

      if (target.kind !== "database") throw Error("Invalid database");

      return Array.from(fields(target).values());
    },
  };
}

function fieldType(value: unknown) {
  if (!types.includes(value as FieldType))
    throw Error("Invalid type. Types: " + types.join(", "));

  return value as FieldType;
}

function relationTarget(run: AgentRun, value: unknown) {
  const target = textArg(value ?? "", ID_LENGTH);

  if (run.page(target)?.kind !== "database")
    throw Error("relation needs target: the ID of a database");

  return target;
}

function optionNames(value: unknown) {
  const names = listArg(value ?? []).map((name) =>
    textArg(name, NAME_LENGTH).replace(/,/g, " ").trim(),
  );

  return [...new Set(names.filter(Boolean))];
}

export async function addField(run: AgentRun, entry: Entry, spec: ToolArgs) {
  const type = fieldType(spec.type);
  const extra = await fieldConfig(
    spec.config,
    { type },
    configContext(run, entry),
  );

  if (type === "formula") extra.formula = formulaSource(spec.formula ?? "");

  return newField(
    entry,
    textArg(spec.name, NAME_LENGTH),
    type,
    optionNames(spec.options),
    type === "relation" ? relationTarget(run, spec.target) : undefined,
    extra,
  );
}

export async function changeField(run: AgentRun, entry: Entry, spec: ToolArgs) {
  const old = findField(Array.from(fields(entry).values()), spec.id);
  const next: Field = { ...old };

  if (spec.name !== undefined)
    next.name = textArg(spec.name, NAME_LENGTH).trim() || old.name;
  if (spec.type !== undefined) next.type = fieldType(spec.type);
  if (next.type === "autoId" && old.type !== "autoId")
    throw Error("Add a new autoId property instead of changing the type");
  if (spec.options !== undefined) next.options = optionNames(spec.options);
  if (spec.target !== undefined) next.target = relationTarget(run, spec.target);
  if (next.type === "relation" && !next.target)
    next.target = relationTarget(run, undefined);
  if (spec.formula !== undefined) next.formula = formulaSource(spec.formula);
  Object.assign(
    next,
    await fieldConfig(spec.config, next, configContext(run, entry)),
  );
  fields(entry).set(old.id, next);

  return old.id;
}

async function samples(run: AgentRun, entry: Entry) {
  const { book } = run;
  const schema = Array.from(fields(entry).values());
  const raw = book.pages.has(entry.id) ? await rowIndex(book, entry) : [];
  const hidden = run.exclusions();
  const scope = await sharedScope(book, schema, hidden);
  const rows = computeRows(sharedRows(raw, schema, hidden), schema, scope);

  return { schema, scope, rows };
}

export async function checkFormulas(
  run: AgentRun,
  entry: Entry,
  ids: string[],
): Promise<FormulaPreview[]> {
  const sample = await samples(run, entry);

  return sample.schema
    .filter((field) => ids.includes(field.id) && field.type === "formula")
    .map((field) =>
      checkFormula(
        field.formula ?? "",
        field.name,
        sample.schema,
        sample.rows,
        sample.scope,
      ),
    );
}

function existingAutomation(entry: Entry, args: ToolArgs) {
  const all = Array.from(automations(entry).values());
  const key =
    args.automation_id === undefined
      ? ""
      : textArg(args.automation_id, NAME_LENGTH);
  const existing = key
    ? all.find((rule) => rule.id === key || rule.name === key)
    : undefined;

  if (key && !existing)
    throw Error(
      "Unknown automation. Automations: " +
        (all.map((rule) => rule.name + " (" + rule.id + ")").join(", ") ||
          "none"),
    );

  return existing;
}

export async function setAutomation(
  run: AgentRun,
  entry: Entry,
  args: ToolArgs,
) {
  const rules = automations(entry);
  const existing = existingAutomation(entry, args);

  if (args.remove === true) {
    if (!existing) throw Error("remove needs automation_id");
    rules.delete(existing.id);

    return { automation_id: existing.id, removed: true, formulas: [] };
  }

  if (!existing && rules.size >= MAX_AUTOMATIONS)
    throw Error("At most 32 automations");
  const sample = await samples(run, entry);
  const rule = automationFrom(args, sample.schema, run.book, existing);
  const formulas = (rule.actions ?? [])
    .filter((step) => step.action === "formula")
    .map((step) =>
      checkFormula(
        step.value,
        rule.name + " → " + (fields(entry).get(step.field)?.name ?? ""),
        sample.schema,
        sample.rows,
        computeScope(run.book),
      ),
    );

  rules.set(rule.id, rule);

  return { automation_id: rule.id, formulas };
}
