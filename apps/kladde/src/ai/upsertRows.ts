import type { Entry } from "../notebook/notebook";
import { fields } from "../database/fields";
import { validValue } from "../database/validValue";
import { type Field } from "../database/types";
import { applyAutomations } from "../database/rules";
import { splitList } from "../database/compute";
import { listArg, objectArg, textArg, type ToolArgs } from "./toolArguments";
import type { ExistingWrite } from "./writeTools";

const NAME_LENGTH = 200;

function propertyOf(database: Entry, key: string): Field {
  const field =
    fields(database).get(key) ??
    Array.from(fields(database).values()).find((item) => item.name === key);

  if (!field) throw Error("Unknown property");

  return field;
}

function rawValue(value: unknown) {
  return typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : textArg(value);
}

async function rowEntry(write: ExistingWrite, spec: ToolArgs) {
  const { run, id, entry } = write;

  if (!spec.id) {
    const row = run.create(textArg(spec.title, NAME_LENGTH), "row", id);

    entry.doc.getArray<string>("row_order").push([row.id]);

    return row;
  }

  const page = run.page(textArg(spec.id));

  if (page?.parent !== id || page.kind !== "row") throw Error("Foreign row");

  return run.entry(textArg(spec.id), true);
}

function setValues(write: ExistingWrite, row: Entry, values: ToolArgs) {
  const { run, entry } = write;
  const changed = new Set<string>();

  for (const [key, value] of Object.entries(values)) {
    const field = propertyOf(entry, key);
    const next = validValue(field, rawValue(value), run.book);

    if (
      field.type === "relation" &&
      splitList(next).some((linked) => run.excluded(linked))
    )
      throw Error("Invalid relation");
    const props = row.doc.getMap<string>("properties");

    if (props.get(field.id) !== next) {
      changed.add(field.id);
      props.set(field.id, next);
    }
  }

  return changed;
}

async function upsertRow(write: ExistingWrite, value: unknown) {
  const { run, entry, outcome } = write;
  const spec = objectArg(value);
  const row = await rowEntry(write, spec);
  const draft = run.changes.get(row.id)!;

  outcome.rows.push(row.id);
  draft.applied = false;
  if (spec.title) draft.page.title = textArg(spec.title, NAME_LENGTH);
  const changed = setValues(write, row, objectArg(spec.values ?? {}));

  if (!spec.id || changed.size)
    applyAutomations(
      run.book,
      entry,
      row,
      draft.page.title,
      spec.id ? "change" : "create",
      changed,
      undefined,
      run.exclusions(),
    );
}

export async function upsertRows(write: ExistingWrite) {
  for (const value of listArg(write.args.rows)) await upsertRow(write, value);
}
