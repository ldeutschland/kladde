import { searchTerms, type Passage } from "../search/search";
import type { AgentRun } from "./AgentRun";
import type { LocalHandles } from "./localHandles";
import type { LocalCall, LocalParameter, LocalTool } from "./localModel";
import { objectArg, type ToolArgs } from "./toolArguments";

const SEARCH_MATCHES = 6;
const RELAXED_TERMS = 4;
const SNIPPET_LENGTH = 180;
const NAME_LENGTH = 80;
const ARGUMENT_LENGTH = 64000;
const PAGE_WINDOW = 40;
const BLOCK_START = /\n(?=\[b:)/;
const BLOCK_PREFIX = /^\[b:[^\]\n]{1,80}\] /;
const LINK_LABEL = /[[\]\p{Cc}]+/gu;
const NO_MATCHES = "No matches. Try other keywords.";
const DRAFT_READY =
  "Draft created, not saved yet. Tell the user that the draft is ready to review. Do not link it.";
const DECLINED = "The user declined this change.";
const HEADER_ROOM = 120;
const ENTRY_PAGES = 12;
const ENTRY_EXCERPTS = 4;
const EXCERPT_LENGTH = 240;
const ENTRIES_HEADER = "Pages in it:";
const EMPTY_PAGE = "(empty)";

const PAGE: LocalParameter = {
  name: "id",
  description: "Page id like p1",
  type: "string",
  optional: false,
};
const MARKDOWN: LocalParameter = {
  name: "markdown",
  description: "Real, complete Markdown content, no placeholders",
  type: "string",
  optional: false,
};
const offset = (description: string): LocalParameter => ({
  name: "offset",
  description,
  type: "integer",
  optional: true,
});

const READ_PLANS: LocalTool[] = [
  {
    name: "search",
    description:
      "Full-text search in the user's notes, PDFs and files. Use 2-4 distinctive keywords. Returns pages with link, id and snippet.",
    parameters: [
      {
        name: "query",
        description: "Keywords",
        type: "string",
        optional: false,
      },
    ],
  },
  {
    name: "read_page",
    description: "Read the text of a page by its id.",
    parameters: [PAGE, offset("Continue at this block")],
  },
  {
    name: "read_attachment",
    description: "Read the text of a file found by search, by its file id.",
    parameters: [
      {
        name: "file",
        description: "File id like f1",
        type: "string",
        optional: false,
      },
      offset("Continue at this offset"),
    ],
  },
];

const WRITE_PLANS: LocalTool[] = [
  {
    name: "create_page",
    description:
      'Create a new page, for example when the user says create, write, note down or make a page or list ("leg an", "erstelle", "notiere", "schreib auf"). Also when similar notes already exist: write the new page using them. The page becomes a draft the user reviews.',
    parameters: [
      {
        name: "title",
        description: "Page title",
        type: "string",
        optional: false,
      },
      MARKDOWN,
    ],
  },
  {
    name: "append_to_page",
    description:
      "Add text to the end of an existing page, for example when the user says add, append or extend. Only the new text, not the whole page. The change becomes a draft the user reviews.",
    parameters: [PAGE, MARKDOWN],
  },
];

export function localToolPlans(mode: string) {
  return mode === "read" ? READ_PLANS : [...READ_PLANS, ...WRITE_PLANS];
}

export function linkTo(handle: string, title: string) {
  const label = title.replace(LINK_LABEL, " ").trim() || "Untitled";

  return "[" + label + "](kladde:" + handle + ")";
}

function clean(text: unknown, limit: number) {
  if (typeof text !== "string") return "";

  return text
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim()
    .slice(0, limit);
}

function textRoom(room: number) {
  return Math.max(0, room - HEADER_ROOM);
}

function wholeNumber(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
}

interface ToolContext {
  task: AgentRun;
  handles: LocalHandles;
  args: ToolArgs;
  room: number;
}

interface Match {
  id: string;
  title: string;
  file: string | null;
  name: string;
  snippet: string;
}

function matchLine(
  handles: LocalHandles,
  match: Match,
  snippetLength = SNIPPET_LENGTH,
) {
  const page = handles.page(match.id);
  const file = match.file
    ? " file " +
      handles.file(match.id, match.file) +
      ' "' +
      clean(match.name, NAME_LENGTH) +
      '"'
    : "";
  const snippet = match.snippet
    ? ": " + clean(match.snippet, snippetLength)
    : "";

  return "- " + linkTo(page, match.title) + " id " + page + file + snippet;
}

async function searchMatches(task: AgentRun, query: unknown) {
  const result = (await task.call("search", { query })) as {
    matches?: Match[];
  };

  return result.matches ?? [];
}

type CountedMatches = Map<string, { match: Match; terms: number }>;

function countMatches(found: CountedMatches, matches: Match[]) {
  for (const match of matches) {
    const key = match.id + "/" + (match.file ?? "");
    const seen = found.get(key);

    found.set(key, {
      match: seen?.match ?? match,
      terms: (seen?.terms ?? 0) + 1,
    });
  }
}

async function relaxedMatches(task: AgentRun, query: unknown) {
  const terms = searchTerms(typeof query === "string" ? query : "")
    .sort((a, b) => b.length - a.length)
    .slice(0, RELAXED_TERMS);
  const found: CountedMatches = new Map();

  if (terms.length < 2) return [];

  for (const term of terms)
    countMatches(found, await searchMatches(task, term));

  return [...found.values()]
    .sort((a, b) => b.terms - a.terms)
    .map((entry) => entry.match);
}

async function searchNotes({ task, handles, args }: ToolContext) {
  const exact = await searchMatches(task, args.query);
  const found = exact.length ? exact : await relaxedMatches(task, args.query);
  const matches = found.slice(0, SEARCH_MATCHES);

  if (!matches.length) return NO_MATCHES;

  return matches.map((match) => matchLine(handles, match)).join("\n");
}

function fitBlocks(blocks: string[], room: number) {
  const shown: string[] = [];
  let used = 0;

  for (const block of blocks) {
    if (used + block.length > room) {
      if (!shown.length) shown.push(block.slice(0, room));
      break;
    }

    shown.push(block);
    used += block.length + 1;
  }

  return shown;
}

function blockTexts(raw: unknown) {
  const blocks = typeof raw === "string" && raw ? raw.split(BLOCK_START) : [];

  return blocks.map((block) => block.replace(BLOCK_PREFIX, ""));
}

function hasChildPages(task: AgentRun, id: string) {
  for (const page of task.book.pages.values())
    if (page.parent === id) return true;

  return false;
}

function listedEntries(listed: unknown): Match[] {
  if (!Array.isArray(listed)) return [];

  return listed
    .filter((entry) => typeof entry?.id === "string")
    .map((entry) => ({
      id: entry.id,
      title: String(entry.title ?? ""),
      file: null,
      name: "",
      snippet: "",
    }));
}

async function excerpt(task: AgentRun, id: string) {
  try {
    const raw = await task.call("read_page", { id, offset: 0 });

    return blockTexts(raw).join(" ");
  } catch (error) {
    if (task.stopped) throw error;

    return "";
  }
}

async function pageEntries(context: ToolContext, id: string, empty: boolean) {
  const { task, handles } = context;

  if (!hasChildPages(task, id)) return [];
  const listed = await task.call("workspace_tree", { parent: id });
  const entries = listedEntries(listed).slice(0, ENTRY_PAGES);

  for (const [index, entry] of entries.entries())
    if (empty && index < ENTRY_EXCERPTS)
      entry.snippet = await excerpt(task, entry.id);

  return entries.map((entry) => matchLine(handles, entry, EXCERPT_LENGTH));
}

async function readPageText(context: ToolContext) {
  const { task, handles, args } = context;
  const room = textRoom(context.room);
  const id = handles.pageId(args.id);

  if (!id) throw Error("Unknown page id. Use an id from search.");
  const start = wholeNumber(args.offset);
  const blocks = blockTexts(
    await task.call("read_page", { id, offset: start }),
  );
  const shown = fitBlocks(blocks, room);
  const more = shown.length < blocks.length || blocks.length === PAGE_WINDOW;
  const next = more ? " (more with offset " + (start + shown.length) + ")" : "";
  const title = linkTo(handles.page(id), task.page(id)?.title ?? "");
  const text = shown.join("\n");
  const entries = start ? [] : await pageEntries(context, id, !text);
  const left = Math.max(0, room - text.length - ENTRIES_HEADER.length);
  const listing = fitBlocks(entries, left).filter(Boolean);
  const parts = listing.length ? [text, ENTRIES_HEADER, ...listing] : [text];
  const body = parts.filter(Boolean).join("\n") || EMPTY_PAGE;

  return "Page " + title + next + ":\n" + body;
}

async function readFileText(context: ToolContext) {
  const { task, handles, args } = context;
  const room = textRoom(context.room);
  const target = handles.fileTarget(args.file);

  if (!target) throw Error("Unknown file id. Use a file id from search.");
  const start = wholeNumber(args.offset);
  const passage = (await task.call("read_attachment", {
    id: target.page,
    file: target.file,
    offset: start,
  })) as Passage;
  const characters = Array.from(String(passage.text ?? ""));
  const next = characters.length > room ? start + room : passage.next_offset;
  const more = next === null ? "" : " (more with offset " + next + ")";
  const status = passage.status === "ready" ? "" : " [" + passage.status + "]";
  const name = '"' + clean(passage.name, NAME_LENGTH) + '"';

  return (
    "File " + name + status + more + ":\n" + characters.slice(0, room).join("")
  );
}

function draftInput(name: string, { handles, args }: ToolContext) {
  if (name === "create_page")
    return { title: args.title, markdown: args.markdown };
  const id = handles.pageId(args.id);

  if (!id) throw Error("Unknown page id. Use an id from search.");

  return { id, markdown: args.markdown };
}

async function draft(name: string, context: ToolContext) {
  const result = await context.task.call(name, draftInput(name, context));
  const declined =
    !!result && typeof result === "object" && "declined" in result;

  return declined ? DECLINED : DRAFT_READY;
}

const HANDLERS: Record<string, (context: ToolContext) => Promise<string>> = {
  search: searchNotes,
  read_page: readPageText,
  read_attachment: readFileText,
  create_page: (context) => draft("create_page", context),
  append_to_page: (context) => draft("append_to_page", context),
};

function parsedArguments(text: string): ToolArgs {
  if (text.length > ARGUMENT_LENGTH) throw Error("Arguments too long");

  return objectArg(JSON.parse(text));
}

export async function callLocalTool(
  task: AgentRun,
  handles: LocalHandles,
  call: LocalCall,
  room: number,
) {
  const handler = Object.hasOwn(HANDLERS, call.name)
    ? HANDLERS[call.name]
    : null;

  if (!handler) return "Error: Unknown tool";

  try {
    return await handler({
      task,
      handles,
      args: parsedArguments(call.arguments),
      room,
    });
  } catch (error) {
    if (task.stopped) throw error;

    return "Error: " + (error instanceof Error ? error.message : String(error));
  }
}
