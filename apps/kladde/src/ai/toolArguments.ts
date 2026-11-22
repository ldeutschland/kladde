import {
  MARKDOWN_LENGTH,
  READ_TOOLS,
  TEXT_LENGTH,
  definitions,
} from "./toolCatalog";

export type ToolArgs = Record<string, unknown>;
export type Permission = "read" | "write" | "confirm";

const MAX_LIST = 100;
const MAX_ARGUMENTS = 64000;
const TOOL_NAME_PREVIEW = 64;
const WHOLE_NUMBER = /^\d{1,15}$/;

export function textArg(value: unknown, limit = TEXT_LENGTH): string {
  if (typeof value !== "string" || value.length > limit)
    throw Error("Invalid text");

  return value;
}

export function listArg(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_LIST)
    throw Error("Invalid list");

  return value;
}

export function objectArg(value: unknown): ToolArgs {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid object");

  return value as ToolArgs;
}

function argumentError(tool: string, key: string, expected: string) {
  return Error(
    "Invalid argument " + key + " for " + tool + ": expected " + expected,
  );
}

function numberArgument(tool: string, key: string, value: unknown) {
  const number =
    typeof value === "string" && WHOLE_NUMBER.test(value.trim())
      ? Number(value)
      : value;

  if (!Number.isSafeInteger(number) || Number(number) < 0)
    throw argumentError(tool, key, "a non-negative integer");

  return number;
}

function booleanArgument(tool: string, key: string, value: unknown) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw argumentError(tool, key, "true or false");
}

function checkedArgument(
  tool: string,
  key: string,
  type: string,
  value: unknown,
) {
  if (type.startsWith("array")) {
    if (!Array.isArray(value) || value.length > MAX_LIST)
      throw argumentError(tool, key, "a list of at most 100 items");

    return value;
  }

  if (type.startsWith("number")) return numberArgument(tool, key, value);
  if (type.startsWith("boolean")) return booleanArgument(tool, key, value);
  const limit = type.startsWith("markdown") ? MARKDOWN_LENGTH : TEXT_LENGTH;

  if (typeof value !== "string" || value.length > limit)
    throw argumentError(tool, key, "text up to " + limit + " characters");

  return value;
}

export function validateCall(name: string, input: unknown) {
  if (!Object.hasOwn(definitions, name))
    throw Error(
      "Unknown tool " +
        JSON.stringify(name.slice(0, TOOL_NAME_PREVIEW)) +
        ". Available: " +
        Object.keys(definitions).join(", "),
    );
  const given = objectArg(input),
    schema = definitions[name],
    clean: ToolArgs = {};

  if (JSON.stringify(given).length > MAX_ARGUMENTS)
    throw Error("Arguments too long");

  for (const [key, type] of Object.entries(schema)) {
    const value = given[key];

    if (value === undefined || value === null) {
      if (type.endsWith("?")) continue;
      throw argumentError(name, key, "a value (required)");
    }

    clean[key] = checkedArgument(name, key, type, value);
  }

  return clean;
}

function needsConfirmation(name: string, args: ToolArgs) {
  return (
    name === "archive_page" ||
    (name === "update_database_schema" &&
      listArg(args.remove ?? []).length > 0) ||
    name === "set_automation" ||
    (name === "edit_page" &&
      listArg(args.operations).some(
        (operation) => objectArg(operation).action === "delete",
      ))
  );
}

export function allowed(
  name: string,
  args: ToolArgs,
  mode: string,
): Permission {
  if (READ_TOOLS.has(name)) return "read";
  if (!["auto", "propose"].includes(mode)) throw Error("Read only");
  if (needsConfirmation(name, args)) return "confirm";

  return "write";
}

export function targets(args: ToolArgs) {
  const rows = Array.isArray(args.rows)
    ? args.rows.map((row) => (row && typeof row === "object" ? row.id : null))
    : [];

  return [args.id, args.parent, args.database, ...rows];
}
