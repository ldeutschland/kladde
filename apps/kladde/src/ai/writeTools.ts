import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { mayMove, type Entry, type Page } from "../notebook/notebook";
import {
  blockEditor,
  blocks,
  markdown,
  writeMarkdown,
} from "../notebook/content";
import { emojiIcon, pageBlocks, styleCallouts } from "../notebook/pageMarkdown";
import { addView, fields, views } from "../database/fields";
import { layouts, type Layout } from "../database/types";
import type { FormulaPreview } from "../database/databaseTools";
import { MARKDOWN_LENGTH } from "./toolCatalog";
import { listArg, objectArg, textArg, type ToolArgs } from "./toolArguments";
import { ruledView } from "./viewArguments";
import { applyBlockOperations } from "./blockOperations";
import {
  addField,
  changeField,
  checkFormulas,
  setAutomation,
} from "./fieldTools";
import { upsertRows } from "./upsertRows";
import type { AgentRun, Draft } from "./AgentRun";

const NAME_LENGTH = 200;

export interface WriteOutcome {
  target: string;
  rows: string[];
  formulas: FormulaPreview[];
  automation?: string;
}

export interface ExistingWrite {
  run: AgentRun;
  name: string;
  args: ToolArgs;
  id: string;
  entry: Entry;
  draft: Draft;
  pages: Map<string, Page>;
  outcome: WriteOutcome;
}

type WriteHandler = (write: ExistingWrite) => void | Promise<void>;

async function createPage(
  run: AgentRun,
  name: string,
  args: ToolArgs,
  outcome: WriteOutcome,
) {
  const entry = run.create(
    textArg(args.title, NAME_LENGTH),
    name === "create_page" ? "page" : "database",
    args.parent ? textArg(args.parent) : null,
  );

  outcome.target = entry.id;
  if (args.icon) run.changes.get(entry.id)!.page.icon = emojiIcon(args.icon);

  if (name === "create_page") {
    if (!args.markdown) return;
    writeMarkdown(
      entry,
      textArg(args.markdown, MARKDOWN_LENGTH),
      styleCallouts,
    );
    entry.doc.getMap("meta").set("text", markdown(entry));

    return;
  }

  const added = [];

  for (const spec of listArg(args.properties))
    added.push(await addField(run, entry, objectArg(spec)));
  outcome.formulas.push(...(await checkFormulas(run, entry, added)));
  addView(
    entry,
    args.view ? textArg(args.view, NAME_LENGTH) : "Table",
    "table",
  );
}

function archivePage({ draft }: ExistingWrite) {
  draft.page.archived = Date.now();
}

function movePage({ args, draft, pages, id }: ExistingWrite) {
  if (args.title) draft.page.title = textArg(args.title, NAME_LENGTH);
  if (args.icon) draft.page.icon = emojiIcon(args.icon);
  if (args.parent === undefined) return;
  const parent = String(args.parent) || null;

  if (
    !mayMove(pages, id, parent) ||
    (parent && pages.get(parent)?.kind === "chat")
  )
    throw Error("Invalid parent");
  draft.page.parent = parent;
}

function editBlocks({ entry, name, args }: ExistingWrite) {
  if (entry.kind !== "page" && entry.kind !== "row")
    throw Error("Expected a page or row");
  const editor = blockEditor(),
    all = blocks(entry);

  if (name === "append_to_page") {
    const text = textArg(args.markdown, MARKDOWN_LENGTH).trim();

    if (!text) throw Error("Empty content");
    all.push(...pageBlocks(text));
  }

  applyBlockOperations(all, listArg(args.operations ?? []));
  const fragment = entry.doc.getXmlFragment("blocks");

  fragment.delete(0, fragment.length);
  blocksToYXmlFragment(editor, all, fragment);
  entry.doc.getMap("meta").set("text", markdown(entry));
}

async function updateSchema({ run, entry, args, outcome }: ExistingWrite) {
  const touched = [];

  for (const spec of listArg(args.add ?? []))
    touched.push(await addField(run, entry, objectArg(spec)));
  for (const spec of listArg(args.change ?? []))
    touched.push(await changeField(run, entry, objectArg(spec)));

  for (const value of listArg(args.rename ?? [])) {
    const rename = objectArg(value),
      old = fields(entry).get(textArg(rename.id));

    if (!old) throw Error("Unknown property");
    fields(entry).set(old.id, {
      ...old,
      name: textArg(rename.name, NAME_LENGTH),
    });
  }

  for (const id of listArg(args.remove ?? []))
    fields(entry).delete(textArg(id));
  outcome.formulas.push(...(await checkFormulas(run, entry, touched)));
}

async function changeAutomation({ run, entry, args, outcome }: ExistingWrite) {
  const result = await setAutomation(run, entry, args);

  outcome.automation = result.automation_id;
  outcome.formulas.push(...result.formulas);
}

function createView({ entry, args }: ExistingWrite) {
  if (!layouts.includes(args.type as Layout)) throw Error("Invalid view");
  const existing = args.view_id
    ? views(entry).get(textArg(args.view_id))
    : undefined;

  if (args.view_id && !existing) throw Error("Unknown view");
  const schema = Array.from(fields(entry).values());
  const name = textArg(args.name, NAME_LENGTH);
  const view = existing
    ? { ...existing, name, type: args.type as Layout }
    : addView(entry, name, args.type as Layout);

  views(entry).set(view.id, ruledView(view, schema, args));
}

function onDatabase(handler: WriteHandler): WriteHandler {
  return (write) => {
    if (write.entry.kind !== "database") throw Error("Invalid database");

    return handler(write);
  };
}

const EXISTING_HANDLERS = new Map<string, WriteHandler>([
  ["archive_page", archivePage],
  ["move_page", movePage],
  ["edit_page", editBlocks],
  ["append_to_page", editBlocks],
  ["update_database_schema", onDatabase(updateSchema)],
  ["set_automation", onDatabase(changeAutomation)],
  ["create_view", onDatabase(createView)],
  ["upsert_rows", onDatabase(upsertRows)],
]);

async function changeExisting(
  run: AgentRun,
  name: string,
  args: ToolArgs,
  pages: Map<string, Page>,
  outcome: WriteOutcome,
) {
  const id = outcome.target;
  const entry = await run.entry(id, true),
    draft = run.changes.get(id)!;

  draft.applied = false;
  await EXISTING_HANDLERS.get(name)?.({
    run,
    name,
    args,
    id,
    entry,
    draft,
    pages,
    outcome,
  });
}

function writeResult(run: AgentRun, outcome: WriteOutcome) {
  const { target, rows, formulas } = outcome;
  const copy = run.changes.get(target)?.copy;

  return {
    id: target,
    rows: rows.length ? rows : undefined,
    automation_id: outcome.automation,
    formula_results: formulas.length ? formulas : undefined,
    schema: copy?.kind === "database" ? fields(copy).toJSON() : undefined,
  };
}

export async function writeTool(
  run: AgentRun,
  name: string,
  args: ToolArgs,
  pages: Map<string, Page>,
) {
  const outcome: WriteOutcome = {
    target: String(args.id ?? ""),
    rows: [],
    formulas: [],
  };

  if (name === "create_page" || name === "create_database")
    await createPage(run, name, args, outcome);
  else await changeExisting(run, name, args, pages, outcome);

  return writeResult(run, outcome);
}
