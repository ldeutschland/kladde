import { restoreContent } from "../notebook/content";
import {
  mayMove,
  unpack,
  type Notebook,
  type Page,
} from "../notebook/notebook";
import { keepVersion, loadVersion } from "../versions/versions";

export interface Placement {
  title: string;
  icon: string;
  parent: string | null;
  archived: number | null;
}
export interface AiChange {
  id: string;
  title: string;
  created: boolean;
  rev: number | null;
  after: number;
  before: Placement | null;
}

const PAGE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MAX_CHANGES = 3000;
const TITLE_LENGTH = 200;
const ICON_LENGTH = 64;
const UNDOABLE_KINDS: Page["kind"][] = ["page", "database", "row"];

export function placementOf(page: Page): Placement {
  const { title, icon, parent, archived } = page;

  return { title, icon, parent, archived };
}

function positiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : null;
}

function savedPlacement(value: unknown): Placement | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  if (typeof raw.title !== "string" || typeof raw.icon !== "string")
    return null;
  const parent = typeof raw.parent === "string" ? raw.parent : "";

  return {
    title: raw.title.slice(0, TITLE_LENGTH),
    icon: raw.icon.slice(0, ICON_LENGTH),
    parent: PAGE_ID.test(parent) ? parent : null,
    archived: positiveInteger(raw.archived),
  };
}

function savedChange(value: unknown): AiChange[] {
  if (!value || typeof value !== "object") return [];
  const raw = value as Record<string, unknown>;

  if (typeof raw.id !== "string" || !PAGE_ID.test(raw.id)) return [];

  return [
    {
      id: raw.id,
      title:
        typeof raw.title === "string" ? raw.title.slice(0, TITLE_LENGTH) : "",
      created: raw.created === true,
      rev: positiveInteger(raw.rev),
      after: positiveInteger(raw.after) ?? 0,
      before: savedPlacement(raw.before),
    },
  ];
}

export function savedChanges(value: unknown): AiChange[] {
  if (!Array.isArray(value)) return [];

  return value.slice(0, MAX_CHANGES).flatMap(savedChange);
}

function undoablePage(book: Notebook, change: AiChange) {
  const page = book.pages.get(change.id);

  return page && UNDOABLE_KINDS.includes(page.kind) ? page : undefined;
}

export async function editedSince(book: Notebook, changes: AiChange[]) {
  await book.flush();
  const titles: string[] = [];

  for (const change of changes) {
    const page = undoablePage(book, change);

    if (!page || change.created) continue;
    const entry = await book.load(change.id);

    if (entry.rev !== change.after) titles.push(page.title || change.title);
  }

  return titles;
}

async function restorePage(book: Notebook, change: AiChange, page: Page) {
  if (!change.rev || !change.before) throw Error("No saved version");
  const stored = await loadVersion(change.id, change.rev);

  if (stored.id !== change.id || stored.space !== book.id)
    throw Error("Foreign version");
  const entry = await book.load(change.id);

  await keepVersion(change.id, null, "restore");
  restoreContent(entry, { ...entry, doc: unpack(stored.data) });
  const { title, icon, parent, archived } = change.before;
  const reachable = mayMove(book.pages, change.id, parent);

  await book.change(change.id, {
    title,
    icon,
    archived,
    parent: reachable ? parent : page.parent,
  });
}

async function undoChange(book: Notebook, change: AiChange) {
  const page = undoablePage(book, change);

  if (change.created) {
    if (page && !page.archived) await book.trashBranch(page.id, Date.now());

    return;
  }

  if (!page) throw Error("Page unavailable");
  await restorePage(book, change, page);
}

export async function undoChanges(book: Notebook, changes: AiChange[]) {
  await book.flush();
  const failed: string[] = [];

  for (const change of changes) {
    try {
      await undoChange(book, change);
    } catch {
      failed.push(book.pages.get(change.id)?.title || change.title);
    }
  }

  await book.flush();

  return failed;
}
