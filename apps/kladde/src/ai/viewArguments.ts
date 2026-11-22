import { type Field, type View } from "../database/types";
import { operators } from "../database/rules";
import { listArg, objectArg, textArg, type ToolArgs } from "./toolArguments";

const NAME_LENGTH = 200;
const OPERATOR_LENGTH = 32;
const VALUE_LENGTH = 2000;

export function fieldId(schema: Field[], value: unknown) {
  if (value === undefined || value === "") return "";
  const key = textArg(value, NAME_LENGTH),
    field = schema.find((item) => item.id === key || item.name === key);

  if (!field) throw Error("Unknown property");

  return field.id;
}

function viewFilter(schema: Field[], value: unknown) {
  const rule = objectArg(value);
  const field = fieldId(schema, rule.field);
  const op =
    rule.op === undefined ? undefined : textArg(rule.op, OPERATOR_LENGTH);
  const type = schema.find((item) => item.id === field)?.type;

  if (op && !operators(type).includes(op)) throw Error("Invalid operator");

  return {
    field,
    op,
    value: textArg(rule.value ?? "", VALUE_LENGTH),
    end: textArg(rule.end ?? "", VALUE_LENGTH),
  };
}

export function viewRules(schema: Field[], args: ToolArgs) {
  if (args.match !== undefined && args.match !== "all" && args.match !== "any")
    throw Error("Invalid filter mode");
  if (
    args.direction !== undefined &&
    args.direction !== "asc" &&
    args.direction !== "desc"
  )
    throw Error("Invalid sort direction");
  const match: View["match"] = args.match === "any" ? "any" : "all";

  return {
    filters: listArg(args.filters ?? []).map((rule) =>
      viewFilter(schema, rule),
    ),
    match,
    sort: fieldId(schema, args.sort),
    descending: args.direction === "desc",
  };
}

export function ruledView(view: View, schema: Field[], args: ToolArgs): View {
  const rules = viewRules(schema, args);

  return {
    ...view,
    filters: args.filters ? rules.filters : view.filters,
    match: args.match ? rules.match : view.match,
    sort: args.sort ? rules.sort : view.sort,
    descending: args.direction ? rules.descending : view.descending,
    group: args.group ? fieldId(schema, args.group) : view.group,
  };
}
