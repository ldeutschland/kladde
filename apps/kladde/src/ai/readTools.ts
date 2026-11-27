import type { Entry, Page } from "../notebook/notebook";
import { command } from "../platform/native";
import {
  readPassage,
  searchContent,
  searchTerms,
  type SearchHit,
} from "../search/search";
import { blocks } from "../notebook/content";
import { blockMarkdown } from "../notebook/pageMarkdown";
import { pagesLinkedIn } from "../notebook/links";
import { withLinksHidden } from "../editor/pageLinkSpec";
import { markdownForAi } from "./aiPages";
import { automations } from "../database/rules";
import { fields, views } from "../database/fields";
import { databaseGuide } from "../database/databaseGuide";
import { textArg, type ToolArgs } from "./toolArguments";
import { queryDatabase } from "./queryDatabase";
import type { AgentRun } from "./AgentRun";

const TREE_PAGE_SIZE = 50;
const TREE_MAX_DEPTH = 8;
const SEARCH_QUERY = 256;
const ID_LENGTH = 36;
const TOPIC_LENGTH = 32;
const MAX_MATCHES = 50;
const MAX_BACKLINKS = 100;
const MAX_CITATIONS = 32;
const QUOTE_LENGTH = 320;
const PAGE_BLOCKS = 40;
const BLOCK_TEXT = 8000;
const PAGE_TEXT = 32000;

export interface ToolRequest {
  name: string;
  args: ToolArgs;
  id: string;
  pages: Map<string, Page>;
  visible: Page[];
  excluded: (id: unknown) => boolean;
}

type ReadTool = (run: AgentRun, request: ToolRequest) => unknown;

function context(run: AgentRun) {
  const open = run.current ? run.page(run.current.id) : undefined;
  const visibleOpen = open && !open.archived && open.kind !== "chat";

  if (visibleOpen) run.shared.add(open.id);

  return {
    open_page: visibleOpen
      ? { id: open.id, title: open.title, kind: open.kind }
      : null,
    attached: run.attached.map((key) => ({
      id: key,
      title: run.page(key)?.title ?? "",
    })),
  };
}

function withinDepth(page: Page, pages: Map<string, Page>, depth: number) {
  let level = 0;

  while (page.parent && level <= depth) {
    const parent = pages.get(page.parent);

    if (!parent) return false;
    page = parent;
    level++;
  }

  return level <= depth;
}

function workspaceTree(run: AgentRun, { args, pages, visible }: ToolRequest) {
  const depth = Math.min(TREE_MAX_DEPTH, Number(args.depth ?? 0));
  const offset = Number(args.offset ?? 0);
  const tree = visible
    .filter((page) =>
      args.parent
        ? page.parent === args.parent
        : withinDepth(page, pages, depth),
    )
    .slice(offset, offset + TREE_PAGE_SIZE);

  tree.forEach((page) => run.shared.add(page.id));

  return tree.map((page) => ({
    id: page.id,
    title: page.title,
    parent: page.parent,
    kind: page.kind,
  }));
}

function titleHits(visible: Page[], matched: Set<string>, query: string) {
  return visible
    .filter(
      (page) =>
        !matched.has(page.id) &&
        page.title.toLowerCase().includes(query.toLowerCase()),
    )
    .map((page) => ({
      doc: page.id,
      file: null,
      name: "",
      snippet: "",
      offset: 0,
    }));
}

function hiddenFromSearch(run: AgentRun, request: ToolRequest, page: Page) {
  const { args } = request;

  return (
    page.archived ||
    page.kind === "chat" ||
    request.excluded(page.id) ||
    (!!args.parent && page.parent !== args.parent) ||
    (!!args.database && page.parent !== args.database) ||
    (!!args.since && run.book.editedAt(page) < Number(args.since))
  );
}

function linksHidden(entry: Entry, request: ToolRequest) {
  const stored = entry.doc.getMap("meta").get("text");

  return pagesLinkedIn(typeof stored === "string" ? stored : "").some((id) =>
    request.excluded(id),
  );
}

function folded(text: string) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

async function shownSnippet(
  run: AgentRun,
  request: ToolRequest,
  hit: SearchHit,
  page: Page,
) {
  if (hit.file) return hit.snippet;
  const entry = await run.book.load(page.id);

  if (!linksHidden(entry, request)) return hit.snippet;
  const visible = folded(
    page.title + "\n" + markdownForAi(entry, request.excluded),
  );
  const terms = searchTerms(textArg(request.args.query, SEARCH_QUERY));

  return terms.every((term) => visible.includes(folded(term))) ? "" : null;
}

async function search(run: AgentRun, request: ToolRequest) {
  const { args, pages, visible } = request;
  const query = textArg(args.query, SEARCH_QUERY).trim();

  if (!query) throw Error("Enter search terms");
  await run.book.flush();
  const scope = args.database || args.parent;
  const result = await searchContent(
    run.book.id,
    query,
    scope ? textArg(scope, ID_LENGTH) : undefined,
  );
  const hits = [...result.hits];

  hits.push(...titleHits(visible, new Set(hits.map((hit) => hit.doc)), query));
  const matches = [];

  for (const hit of hits) {
    const page = pages.get(hit.doc);

    if (!page || hiddenFromSearch(run, request, page)) continue;
    const snippet = await shownSnippet(run, request, hit, page);

    if (snippet === null) continue;
    run.shared.add(page.id);
    matches.push({
      id: page.id,
      title: page.title,
      file: hit.file,
      offset: hit.offset,
      name: hit.name,
      snippet,
    });
    if (matches.length === MAX_MATCHES) break;
  }

  return { matches, pending_attachments: result.pending };
}

function openedPage(run: AgentRun, { id, args }: ToolRequest) {
  const page = run.page(id);

  if (!page || page.archived || page.kind === "chat")
    throw Error("Unknown page");
  run.shared.add(id);

  return { space: run.book.id, doc: id, offset: Number(args.offset ?? 0) };
}

function listAttachments(run: AgentRun, request: ToolRequest) {
  return command("list_attachments", openedPage(run, request));
}

function readAttachment(run: AgentRun, request: ToolRequest) {
  const opened = openedPage(run, request);

  return readPassage(
    run.book.id,
    request.id,
    textArg(request.args.file, ID_LENGTH),
    opened.offset,
    true,
  );
}

async function inspectDatabase(run: AgentRun, request: ToolRequest) {
  openedPage(run, request);
  const db = await run.entry(request.id, false);

  if (db.kind !== "database") throw Error("Invalid database");

  return {
    fields: fields(db).toJSON(),
    views: views(db).toJSON(),
    automations: automations(db).toJSON(),
  };
}

async function backlinks(run: AgentRun, request: ToolRequest) {
  openedPage(run, request);
  const ids = await command<string[]>("backlinks", { id: request.id });

  return ids
    .flatMap((key) => {
      const page = request.pages.get(key);

      if (!page || page.archived || page.kind === "chat") return [];
      if (request.excluded(key)) return [];
      run.shared.add(key);

      return [{ id: key, title: page.title }];
    })
    .slice(0, MAX_BACKLINKS);
}

async function readPage(run: AgentRun, { id, args, excluded }: ToolRequest) {
  const entry = await run.entry(id, false);
  const offset = Number(args.offset ?? 0);
  const shown = (block: ReturnType<typeof blocks>[number]) =>
    ("[b:" + block.id + "] " + blockMarkdown(block)).slice(0, BLOCK_TEXT);

  run.shared.add(id);

  return withLinksHidden(excluded, () =>
    blocks(entry)
      .slice(offset, offset + PAGE_BLOCKS)
      .map(shown)
      .join("\n")
      .slice(0, PAGE_TEXT),
  );
}

async function citedText(run: AgentRun, request: ToolRequest, title: string) {
  const { args, id, excluded } = request;
  const offset = Number(args.offset ?? 0);
  const file = args.file ? textArg(args.file, ID_LENGTH) : null;

  if (!file)
    return {
      file,
      offset,
      page: 0,
      name: title,
      text: markdownForAi(await run.book.load(id), excluded),
    };
  const passage = await readPassage(run.book.id, id, file, offset, true);

  return {
    file,
    offset,
    page: passage.page ?? 0,
    name: passage.name,
    text: passage.text,
  };
}

async function cite(run: AgentRun, request: ToolRequest) {
  const { id, args } = request;
  const page = run.book.pages.get(id);

  if (!page || page.archived || page.kind === "chat")
    throw Error("Source unavailable");
  if (run.citations.length >= MAX_CITATIONS) throw Error("Source unavailable");
  const quote = textArg(args.quote, QUOTE_LENGTH).trim();

  if (!quote || quote.includes("\0") || quote.includes("\f"))
    throw Error("Invalid quote");
  const source = await citedText(run, request, page.title);
  const start = source.text.indexOf(quote);

  if (start < 0) throw Error("Quote not found in source");
  const prefix = source.text.slice(0, start);
  const pageIndex = source.file
    ? source.page + prefix.split("\f").length - 1
    : source.page;

  run.citations.push({
    doc: id,
    file: source.file,
    name: source.name,
    snippet: quote,
    matched: quote,
    page: pageIndex,
    offset: (source.file ? source.offset : 0) + Array.from(prefix).length,
  });
  run.shared.add(id);

  return {
    quote,
    link: "source:" + run.citations.length,
    title: source.name,
  };
}

const READ_HANDLERS = new Map<string, ReadTool>([
  [
    "ask_user",
    async (run, { args }) => ({
      answer: await run.ask(textArg(args.question), ""),
    }),
  ],
  [
    "database_guide",
    (_, { args }) => ({
      reference: databaseGuide(textArg(args.topic, TOPIC_LENGTH)),
    }),
  ],
  ["get_context", context],
  ["workspace_tree", workspaceTree],
  ["search", search],
  ["list_attachments", listAttachments],
  ["read_attachment", readAttachment],
  ["backlinks", backlinks],
  ["inspect_database", inspectDatabase],
  ["cite", cite],
  ["read_page", readPage],
  ["query_database", queryDatabase],
]);

export function readTool(name: string) {
  return READ_HANDLERS.get(name);
}
