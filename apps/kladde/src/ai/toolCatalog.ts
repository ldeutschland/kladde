import { types } from "../database/types";

export const TEXT_LENGTH = 8192;
export const MARKDOWN_LENGTH = 32000;

export const definitions: Record<string, Record<string, string>> = {
  get_context: {},
  workspace_tree: { depth: "number?", offset: "number?", parent: "string?" },
  search: {
    query: "string",
    parent: "string?",
    database: "string?",
    since: "number?",
  },
  read_page: { id: "string", offset: "number?" },
  list_attachments: { id: "string", offset: "number?" },
  read_attachment: { id: "string", file: "string", offset: "number?" },
  cite: { id: "string", file: "string?", offset: "number?", quote: "string" },
  backlinks: { id: "string" },
  inspect_database: { id: "string" },
  database_guide: { topic: "string" },
  create_page: {
    title: "string",
    markdown: "markdown?",
    parent: "string?",
    icon: "string?",
  },
  edit_page: { id: "string", operations: "array" },
  append_to_page: { id: "string", markdown: "markdown" },
  move_page: {
    id: "string",
    parent: "string?",
    title: "string?",
    icon: "string?",
  },
  archive_page: { id: "string" },
  create_database: {
    title: "string",
    properties: "array",
    parent: "string?",
    icon: "string?",
    view: "string?",
  },
  update_database_schema: {
    id: "string",
    add: "array?",
    change: "array?",
    rename: "array?",
    remove: "array?",
  },
  set_automation: {
    id: "string",
    automation_id: "string?",
    name: "string?",
    trigger: "string?",
    watch: "string?",
    match: "string?",
    filters: "array?",
    actions: "array?",
    enabled: "boolean?",
    remove: "boolean?",
  },
  query_database: {
    id: "string",
    query: "string?",
    limit: "number?",
    offset: "number?",
    filters: "array?",
    match: "string?",
    sort: "string?",
    direction: "string?",
  },
  upsert_rows: { id: "string", rows: "array" },
  create_view: {
    id: "string",
    name: "string",
    type: "string",
    group: "string?",
    view_id: "string?",
    filters: "array?",
    match: "string?",
    sort: "string?",
    direction: "string?",
  },
  ask_user: { question: "string" },
};
export const READ_TOOLS = new Set([
  "get_context",
  "workspace_tree",
  "search",
  "read_page",
  "cite",
  "list_attachments",
  "read_attachment",
  "backlinks",
  "inspect_database",
  "database_guide",
  "query_database",
  "ask_user",
]);
const descriptions: Record<string, string> = {
  get_context:
    "Get the ID and title of the page open in the app and of the pages the user attached. Returns no page text; use read_page for content.",
  workspace_tree:
    "List notebook pages by title only. Use it only when the user asks about the notebook's structure; for questions about content use search. Without parent it lists the top-level pages (depth adds levels below them); with parent it lists the direct children of that page. Returns up to 50 entries starting at offset.",
  search:
    "Full-text search over page titles, page text, file names, PDFs, OCR and Office files. Use a few distinctive keywords, not a sentence. Returns excerpts with page IDs and file IDs. parent or database limits the search to direct children; since is a Unix time in milliseconds.",
  read_page:
    "Read a page or database row as Markdown blocks with block IDs, 40 blocks at a time. Continue with next_offset when present.",
  list_attachments:
    "List the files attached to a page with their extraction status, 50 at a time from offset.",
  read_attachment:
    "Read extracted text of one file on a page, 8000 characters at a time. Continue with next_offset. status tells whether the file is pending, partial, unsupported or unreadable.",
  cite: "Check that quote appears verbatim in a page (or in file on that page, with the offset used when reading it) and get a citation number. Write the citation in the answer as [Title](source:N).",
  backlinks: "List the pages that link to the page with this ID.",
  inspect_database:
    "Show a database's properties with IDs, types, options, formulas and settings, its views and its automations. Call this before query_database, upsert_rows, update_database_schema or set_automation.",
  database_guide:
    "Reference for writing formulas, property settings (number and date formats, rollups, unique IDs, buttons) and automations. topic is formulas, properties or automations. Call it once per topic before using these features; skip it otherwise.",
  create_page:
    "Create a page under an optional parent page. markdown is the page body (see Building pages; up to 32000 characters) and must not repeat the title as a heading. icon is one emoji that fits the topic. Returns the new page ID.",
  edit_page:
    "Change blocks of a page. Each operation has action insert_after, replace, delete or move and the block_id from read_page. insert_after and replace need markdown; move needs after (the block ID to move behind).",
  append_to_page:
    "Append Markdown to the end of a page or row without changing existing content.",
  move_page:
    "Change a page's place or look: move it to a new parent, rename it with title, or set icon to one emoji. Only the given parts change.",
  archive_page: "Move a page to the trash. The user is asked first.",
  create_database:
    "Create a database for things the user tracks, sorts or filters. properties lists columns with name, type, options (select, status, multi), target (relation: database ID), formula and config. icon is one emoji; view names the first table view in the user's language. Before using formula, rollup, autoId, button or config, call database_guide.",
  update_database_schema:
    "Change database properties: add new ones, change existing ones by ID or name (name, type, options, target, formula, config), rename by ID, remove by ID. Formulas and settings are checked before saving; errors say what to fix. Before writing formulas or config, call database_guide.",
  set_automation:
    "Create an automation in database id (without automation_id), change one (with automation_id; only given parts change) or delete it (remove true). Properties by name or ID. Call database_guide with topic automations first.",
  query_database:
    "Find rows of a database. filters use field (name or ID), value, optional op and end. Valid ops depend on the field type: equals, contains, emptyValue, filledValue, greater, less, between, beforeDate, afterDate, nextDays, pastDays, today, thisWeek, thisMonth, thisYear, checked, unchecked, hasOption. match is all or any. sort is a property name or ID, direction asc or desc. Paginate with offset and limit.",
  upsert_rows:
    "Create rows (without id) or update rows (with id) in a database. values maps property names or IDs to text values; dates are YYYY-MM-DD, checkboxes true or false, multi-select comma separated.",
  create_view:
    "Add a view to a database or change one (with view_id). type is table, board, list, gallery or calendar. group is a property name or ID: the columns of a board, the date of a calendar. filters, match, sort and direction work as in query_database and are saved with the view, for example open items sorted by due date.",
  ask_user:
    "Ask the user one short question. Use only when required information is missing and cannot be found in the notebook.",
};
const textItem = { type: "string" };
const propertyItem = {
  type: "object",
  properties: {
    name: { type: "string" },
    type: { type: "string", enum: [...types] },
    options: { type: "array", items: textItem },
    target: { type: "string" },
    formula: { type: "string" },
    config: {
      type: "object",
      description: "Formats and settings; see database_guide topic properties.",
    },
  },
  required: ["name", "type"],
};
const filterItem = {
  type: "object",
  properties: {
    field: { type: "string" },
    value: { type: "string" },
    op: { type: "string" },
    end: { type: "string" },
  },
  required: ["field"],
};
const itemSchemas: Record<string, object> = {
  "edit_page.operations": {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["insert_after", "replace", "delete", "move"],
      },
      block_id: { type: "string" },
      markdown: { type: "string" },
      after: { type: "string" },
    },
    required: ["action", "block_id"],
  },
  "create_database.properties": propertyItem,
  "update_database_schema.add": propertyItem,
  "update_database_schema.rename": {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
    required: ["id", "name"],
  },
  "update_database_schema.remove": textItem,
  "update_database_schema.change": {
    type: "object",
    properties: {
      id: { type: "string", description: "Property ID or name." },
      name: { type: "string" },
      type: { type: "string", enum: [...types] },
      options: { type: "array", items: textItem },
      target: { type: "string" },
      formula: { type: "string" },
      config: { type: "object" },
    },
    required: ["id"],
  },
  "set_automation.filters": {
    type: "object",
    properties: {
      field: { type: "string" },
      op: { type: "string" },
      value: { type: "string" },
      end: { type: "string" },
    },
  },
  "set_automation.actions": {
    type: "object",
    properties: {
      field: { type: "string" },
      action: { type: "string" },
      value: { type: "string" },
    },
    required: ["field", "action"],
  },
  "query_database.filters": filterItem,
  "create_view.filters": filterItem,
  "upsert_rows.rows": {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      values: {
        type: "object",
        description: "Property name or ID mapped to the new text value.",
      },
    },
  },
};

function parameterSchema(tool: string, key: string, type: string) {
  const base = type.replace("?", "");

  if (base === "array")
    return {
      type: "array",
      maxItems: 100,
      items: itemSchemas[tool + "." + key] ?? textItem,
    };
  if (base === "number") return { type: "integer", minimum: 0 };
  if (base === "markdown") return { type: "string" };

  return { type: base };
}

export const tools = Object.entries(definitions).map(([name, props]) => ({
  type: "function",
  function: {
    name,
    description: descriptions[name] ?? name,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(props).map(([key, type]) => [
          key,
          parameterSchema(name, key, type),
        ]),
      ),
      required: Object.entries(props)
        .filter(([, type]) => !type.endsWith("?"))
        .map(([key]) => key),
    },
  },
}));

export function toolsForMode(mode: string) {
  return mode === "read"
    ? tools.filter((tool) => READ_TOOLS.has(tool.function.name))
    : tools;
}
