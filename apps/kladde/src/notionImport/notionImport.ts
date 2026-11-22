import { markdown, writeMarkdown } from "../notebook/content";
import { fileBlockType, saveFile } from "../files/attachments";
import { storeImage } from "../capture/clipper";
import { pageLink } from "../notebook/links";
import { translator, type T } from "../locale/locale";
import { addView, fields, newField, views } from "../database/fields";
import { validValue } from "../database/validValue";
import type { Entry, Kind, Notebook } from "../notebook/notebook";
import {
  asFile,
  exportFiles,
  readSources,
  type ExportFile,
} from "./notionFiles";
import {
  buildPlan,
  creationOrder,
  exportName,
  isWebHref,
  linkedNotionId,
  resolveHref,
  type Plan,
  type PlanNode,
} from "./notionPlan";
import {
  convertCallouts,
  markdownLinks,
  rewriteLinks,
  splitPage,
  standaloneLines,
  type MarkdownLink,
} from "./notionMarkdown";
import {
  convertValue,
  inferColumn,
  parseTable,
  rowKey,
  withoutMentions,
  type Column,
  type Table,
} from "./notionTable";

const FLUSH_EVERY = 50;
const MAX_COLUMNS = 100;
const ATTACHMENT_PAGES = /\.(md|csv)$/i;

export interface NotionOptions {
  root: string | null;
  remoteImages: boolean;
  progress?: (done: number, total: number) => void;
}

export interface NotionResult {
  first: string;
  pages: number;
  databases: number;
  files: number;
  skipped: string[];
}

interface DatabaseRow {
  id: string;
  values: string[];
}

interface DatabasePlan {
  node: PlanNode;
  table: Table;
  rows: DatabaseRow[];
}

interface Attachment {
  type: "file" | "image" | "audio" | "video";
  name: string;
}

interface Run {
  book: Notebook;
  plan: Plan;
  files: Map<string, ExportFile>;
  ids: Map<string, string>;
  databases: DatabasePlan[];
  options: NotionOptions;
  result: NotionResult;
  roots: string[];
}

function bookTranslator(book: Notebook) {
  return translator(String(book.settings.get("language") ?? "de"));
}

function createEntry(
  run: Run,
  title: string,
  kind: Kind,
  parent: string | null,
) {
  const entry = run.book.add(title, kind, parent ?? run.options.root);

  if (!parent) run.roots.push(entry.id);

  return entry;
}

function parentId(run: Run, node: PlanNode) {
  return node.parent ? (run.ids.get(node.parent) ?? null) : null;
}

function tableOf(run: Run, node: PlanNode) {
  try {
    return parseTable(node.text);
  } catch {
    run.result.skipped.push(node.path);

    return { header: [], rows: [] };
  }
}

function rowNodes(run: Run, database: PlanNode) {
  return [...run.plan.nodes.values()].filter(
    (n) => n.kind === "row" && n.parent === database.notionId,
  );
}

function matchRows(table: Table, nodes: PlanNode[]) {
  const unmatched = [...nodes];
  const matches = table.rows.map((row) => {
    const key = rowKey(row[0] ?? "");
    const index = unmatched.findIndex((n) => rowKey(n.title) === key);

    return index < 0 ? undefined : unmatched.splice(index, 1)[0];
  });

  return { matches, leftovers: unmatched };
}

function leftoverValues(table: Table, node: PlanNode) {
  const { properties } = splitPage(node.text, new Set(table.header.slice(1)));

  return [
    node.title,
    ...table.header.slice(1).map((name) => properties.get(name) ?? ""),
  ];
}

function createRow(run: Run, database: Entry, title: string, node?: PlanNode) {
  const row = createEntry(run, withoutMentions(title), "row", database.id);

  if (node) run.ids.set(node.notionId, row.id);
  run.result.pages++;

  return row.id;
}

function createDatabase(run: Run, node: PlanNode) {
  const database = createEntry(
    run,
    node.title,
    "database",
    parentId(run, node),
  );

  run.ids.set(node.notionId, database.id);
  const table = tableOf(run, node);
  const { matches, leftovers } = matchRows(table, rowNodes(run, node));
  const rows = table.rows.map((values, i) => ({
    id: createRow(run, database, values[0] ?? "", matches[i]),
    values,
  }));

  for (const leftover of leftovers) {
    const values = leftoverValues(table, leftover);

    rows.push({ id: createRow(run, database, values[0], leftover), values });
  }

  database.doc.getArray<string>("row_order").push(rows.map((r) => r.id));
  run.databases.push({ node, table, rows });
  run.result.databases++;
}

async function createNodes(run: Run) {
  const base = Date.now();

  for (const [index, node] of creationOrder(run.plan).entries()) {
    if (run.ids.has(node.notionId)) continue;

    if (node.kind === "database") createDatabase(run, node);
    else {
      const kind = node.kind === "row" ? "row" : "page";
      const entry = createEntry(run, node.title, kind, parentId(run, node));

      run.ids.set(node.notionId, entry.id);
      run.result.pages++;
    }

    await run.book.change(run.ids.get(node.notionId)!, { order: base + index });
    if (index % FLUSH_EVERY === FLUSH_EVERY - 1) await run.book.flush();
  }
}

function databaseOfRow(run: Run) {
  return (notionId: string) => {
    const node = run.plan.nodes.get(notionId);

    return node?.kind === "row" ? (node.parent ?? undefined) : undefined;
  };
}

function viewHeader(viewTable: string) {
  try {
    return viewTable ? parseTable(viewTable).header.slice(1) : [];
  } catch {
    return [];
  }
}

function columnOrder(table: Table, viewTable: string) {
  const view = viewHeader(viewTable);
  const indices = table.header.map((_, i) => i).slice(1);
  const visible = view
    .map((name) => table.header.indexOf(name, 1))
    .filter((i) => i > 0);
  const rest = indices.filter((i) => !visible.includes(i));

  return { order: [...visible, ...rest].slice(0, MAX_COLUMNS), visible };
}

function resolvedColumn(run: Run, column: Column): Column {
  if (column.type !== "relation") return column;
  const target = run.ids.get(column.target);

  return target
    ? { ...column, target }
    : { ...column, type: "text", target: "" };
}

function createField(database: Entry, column: Column, fallback: string) {
  const name = column.name.trim().slice(0, 200) || fallback;

  return newField(
    database,
    name,
    column.type,
    column.options,
    column.target || undefined,
  );
}

function addViews(
  database: Entry,
  t: T,
  visible: string[] | null,
  status?: string,
) {
  const table = addView(database, t("table"), "table");

  views(database).set(table.id, { ...table, visible });
  if (!status) return;
  const board = addView(database, t("board"), "board");

  views(database).set(board.id, { ...board, group: status, visible });
}

function storeValue(
  run: Run,
  database: Entry,
  row: Entry,
  fieldId: string,
  value: string,
) {
  const field = fields(database).get(fieldId);

  if (!field || !value) return;

  try {
    row.doc
      .getMap("properties")
      .set(fieldId, validValue(field, value, run.book));
  } catch {
    return;
  }
}

async function fillDatabase(run: Run, plan: DatabasePlan) {
  const database = await run.book.load(run.ids.get(plan.node.notionId)!);
  const { order, visible } = columnOrder(plan.table, plan.node.viewTable);
  const columns = order.map((i) => {
    const values = plan.rows.map((r) => r.values[i] ?? "");

    return resolvedColumn(
      run,
      inferColumn(plan.table.header[i], values, databaseOfRow(run)),
    );
  });
  const t = bookTranslator(run.book);
  const fieldIds = columns.map((column, i) =>
    createField(database, column, `${t("property")} ${i + 1}`),
  );
  const hidesColumns = visible.length > 0 && visible.length < order.length;
  const shown = hidesColumns ? fieldIds.slice(0, visible.length) : null;
  const status = fieldIds.find(
    (id) => fields(database).get(id)?.type === "status",
  );

  addViews(database, t, shown, status);

  for (const row of plan.rows) {
    const entry = await run.book.load(row.id);

    for (const [i, column] of columns.entries()) {
      const raw = row.values[order[i]] ?? "";
      const value = convertValue(column, raw, (id) => run.ids.get(id));

      storeValue(run, database, entry, fieldIds[i], value);
    }
  }
}

function attachmentPath(run: Run, node: PlanNode, link: MarkdownLink) {
  if (isWebHref(link.href)) return "";
  const path = resolveHref(node.path, link.href);

  return run.files.has(path) && !ATTACHMENT_PAGES.test(path) ? path : "";
}

async function uploadLocal(run: Run, entry: Entry, path: string) {
  const file = asFile(run.files.get(path)!);

  try {
    const url = await saveFile(run.book, entry, file);

    run.result.files++;

    return { url, attachment: { type: fileBlockType(file), name: file.name } };
  } catch (error) {
    run.result.skipped.push(
      path + " · " + String(error instanceof Error ? error.message : error),
    );

    return null;
  }
}

async function uploadRemote(run: Run, entry: Entry, address: string) {
  if (!run.options.remoteImages || !address.startsWith("https://")) return null;

  try {
    const url = await storeImage(run.book, entry, address);

    run.result.files++;

    return { url, attachment: { type: "image" as const, name: "image" } };
  } catch {
    run.result.skipped.push(address);

    return null;
  }
}

async function uploadAll(run: Run, node: PlanNode, entry: Entry, text: string) {
  const standalone = standaloneLines(text);
  const urls = new Map<string, string>();
  const attachments = new Map<string, Attachment>();

  for (const link of markdownLinks(text)) {
    if (urls.has(link.href) || !(link.image || standalone.has(link.whole)))
      continue;
    const path = attachmentPath(run, node, link);
    const stored = path
      ? await uploadLocal(run, entry, path)
      : link.image
        ? await uploadRemote(run, entry, link.href)
        : null;

    if (!stored) continue;
    urls.set(link.href, stored.url);
    attachments.set(stored.url, stored.attachment);
  }

  return { urls, attachments };
}

function pageTarget(run: Run, node: PlanNode, href: string) {
  const id = linkedNotionId(node.path, href, run.plan.byPath);

  return id ? run.ids.get(id) : undefined;
}

function replaceLink(
  run: Run,
  node: PlanNode,
  link: MarkdownLink,
  urls: Map<string, string>,
) {
  const label = link.label.trim();
  const stored = urls.get(link.href);

  if (stored) return `![${label}](${stored})`;
  if (link.href.startsWith("data:")) return link.image ? "" : label;
  const target = pageTarget(run, node, link.href);

  if (target) {
    const title = run.book.pages.get(target)?.title.replace(/[[\]]/g, "\\$&");

    return `[${label || title || "↗"}](${pageLink(target)})`;
  }

  if (isWebHref(link.href)) return link.whole;

  return link.image ? "" : label;
}

type Blocks = Parameters<NonNullable<Parameters<typeof writeMarkdown>[2]>>[0];

function fileBlocks(attachments: Map<string, Attachment>) {
  const adjust = (blocks: Blocks): Blocks =>
    blocks.map((block) => {
      const children = adjust(block.children as Blocks);
      const url = (block.props as { url?: unknown }).url;
      const file = typeof url === "string" ? attachments.get(url) : undefined;

      if (block.type !== "image" || !file || file.type === "image")
        return { ...block, children };

      return {
        ...block,
        type: file.type,
        props: { name: file.name, url },
        children,
      };
    }) as Blocks;

  return adjust;
}

function propertyNames(run: Run, node: PlanNode) {
  if (node.kind !== "row" || !node.parent) return new Set<string>();
  const header = run.databases.find((d) => d.node.notionId === node.parent)
    ?.table.header;

  return new Set(header?.slice(1) ?? []);
}

async function writeBody(run: Run, node: PlanNode) {
  const entry = await run.book.load(run.ids.get(node.notionId)!);
  const body = convertCallouts(
    splitPage(node.text, propertyNames(run, node)).body,
  );
  const { urls, attachments } = await uploadAll(run, node, entry, body);
  const text = rewriteLinks(body, (link) => replaceLink(run, node, link, urls));

  writeMarkdown(entry, text, fileBlocks(attachments));
  entry.doc.getMap("meta").set("text", markdown(entry));
}

async function writeContent(run: Run) {
  const pages = [...run.plan.nodes.values()].filter(
    (n) => n.kind !== "database",
  );
  const total = pages.length + run.databases.length;
  let done = 0;

  for (const plan of run.databases) {
    await fillDatabase(run, plan);
    run.options.progress?.(++done, total);
  }

  for (const node of pages) {
    if (!run.ids.has(node.notionId)) continue;
    await writeBody(run, node);
    run.options.progress?.(++done, total);
    if (done % FLUSH_EVERY === 0) await run.book.flush();
  }
}

async function rollback(run: Run) {
  for (const id of run.roots)
    await run.book.trashBranch(id, Date.now()).catch(() => {});
}

export async function importNotion(
  book: Notebook,
  list: File[],
  options: NotionOptions,
): Promise<NotionResult> {
  const result: NotionResult = {
    first: "",
    pages: 0,
    databases: 0,
    files: 0,
    skipped: [],
  };
  const exported = await exportFiles(list);
  const plan = buildPlan(await readSources(exported, result.skipped));

  if (!plan.nodes.size) throw Error(bookTranslator(book)("notionEmpty"));
  const files = new Map(exported.map((f) => [f.path, f]));
  const run: Run = {
    book,
    plan,
    files,
    ids: new Map(),
    databases: [],
    options,
    result,
    roots: [],
  };

  try {
    await createNodes(run);
    await book.flush();
    await writeContent(run);
    await book.flush();
  } catch (error) {
    await rollback(run);
    throw error;
  }

  result.first = run.roots[0] ?? "";

  return result;
}

export function looksLikeNotion(list: File[]) {
  return list.some(
    (file) =>
      /\.zip$/i.test(file.name) || exportName(file.name)?.extension === "md",
  );
}
