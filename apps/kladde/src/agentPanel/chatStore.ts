import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { notebookCitation, type SearchHit } from "../search/search";
import { webSource } from "../ai/assistant";
import { savedChanges } from "../ai/aiUndo";
import type { Item, MemoryMark } from "./types";

const MEMORY_STATES = ["saved", "failed"];
const MEMORY_CHANGES = 5;
const MEMORY_LINE = 200;
const MEMORY_ERROR = 300;
const SAVED_SOURCES = 24;
const SAVED_CITATIONS = 32;
const SHARED_PAGES = 500;
const CHAT_TITLE = 60;

export interface ChatToStore {
  id: string | null;
  items: Item[];
  question: string;
  template: string;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value.filter((entry): entry is string => typeof entry === "string");
}

function memoryLines(value: unknown) {
  return stringList(value)
    .slice(0, MEMORY_CHANGES)
    .map((line) => line.slice(0, MEMORY_LINE));
}

function savedMemory(value: unknown): MemoryMark | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;

  if (!MEMORY_STATES.includes(String(raw.state))) return undefined;

  return {
    state: raw.state as MemoryMark["state"],
    page: typeof raw.page === "string" ? raw.page : "",
    added: memoryLines(raw.added),
    removed: memoryLines(raw.removed),
    cost: typeof raw.cost === "number" ? raw.cost : 0,
    error:
      typeof raw.error === "string" ? raw.error.slice(0, MEMORY_ERROR) : "",
  };
}

function savedSources(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .slice(0, SAVED_SOURCES)
    .map(webSource)
    .filter((source) => source !== null);
}

function savedCitations(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .slice(0, SAVED_CITATIONS)
    .map(notebookCitation)
    .filter((citation): citation is SearchHit => !!citation);
}

function savedItem(value: unknown): Item | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const { role, text } = raw;

  if (role !== "user" && role !== "assistant") return null;
  if (typeof text !== "string") return null;

  return {
    role,
    text,
    steps: stringList(raw.steps),
    cost: typeof raw.cost === "number" ? raw.cost : 0,
    sources: savedSources(raw.sources),
    citations: savedCitations(raw.citations),
    shared: stringList(raw.shared).slice(0, SHARED_PAGES),
    error: typeof raw.error === "string" ? raw.error : undefined,
    memory: savedMemory(raw.memory),
    changes: savedChanges(raw.changes),
    undone: raw.undone === true,
  };
}

export function savedThread(value: unknown): Item[] {
  if (!Array.isArray(value)) return [];

  return value.map(savedItem).filter((item): item is Item => item !== null);
}

function storedItem(item: Item) {
  return {
    role: item.role,
    text: item.text,
    steps: item.steps ?? [],
    cost: item.cost ?? 0,
    sources: item.sources ?? [],
    shared: item.shared ?? [],
    citations: item.citations ?? [],
    error: item.error ?? "",
    memory: item.memory?.state === "saving" ? undefined : item.memory,
    changes: item.changes ?? [],
    undone: item.undone === true,
  };
}

export async function loadChat(book: Notebook, id: string) {
  const page = book.pages.get(id);

  if (!page || page.kind !== "chat" || page.archived) return null;
  const entry = await book.load(id);
  const data = entry.doc.getMap("chat");
  const items = savedThread(data.get("thread"));
  const answer = data.get("answer");
  const template = data.get("template");
  const legacyAnswer = !items.length && typeof answer === "string" && answer;

  return {
    items: legacyAnswer
      ? [{ role: "assistant", text: legacyAnswer } satisfies Item]
      : items,
    template: typeof template === "string" ? template : "",
  };
}

export async function storedThread(book: Notebook, id: string) {
  const entry = await book.load(id);

  return savedThread(entry.doc.getMap("chat").get("thread"));
}

export async function writeThread(book: Notebook, id: string, items: Item[]) {
  const entry = await book.load(id);

  entry.doc.getMap("chat").set("thread", items.map(storedItem));
  await book.change(id, {});
}

function chatTitle(t: T, question: string) {
  return t("ai") + " · " + question.slice(0, CHAT_TITLE);
}

export async function storeChat(book: Notebook, t: T, chat: ChatToStore) {
  const id =
    chat.id && book.pages.has(chat.id)
      ? chat.id
      : book.add(chatTitle(t, chat.question), "chat").id;
  const entry = await book.load(id);

  entry.doc.getMap("chat").set("template", chat.template);
  await writeThread(book, id, chat.items);
  book.settings.set("lastChat", id);

  return id;
}
