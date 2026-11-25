import { markdown, writeMarkdown } from "../notebook/content";
import { pageLink } from "../notebook/links";
import {
  mayMove,
  type Entry,
  type Notebook,
  type Page,
} from "../notebook/notebook";
import type { T, Word } from "../locale/locale";

export const AI_ROLES = ["instructions", "template", "memory"] as const;
export type AiRole = (typeof AI_ROLES)[number];

export interface ContextPage {
  id: string;
  title: string;
  text: string;
  truncated: boolean;
}

export const ROLE_LABELS = {
  instructions: "aiInstructions",
  template: "aiTemplates",
  memory: "aiMemories",
} as const satisfies Record<AiRole, Word>;

export const ROLE_HINTS = {
  instructions: "aiInstructionsHint",
  template: "aiTemplatesHint",
  memory: "aiMemoriesHint",
} as const satisfies Record<AiRole, Word>;

export const ROLE_BUDGETS: Record<AiRole, number> = {
  instructions: 8000,
  template: 8000,
  memory: 6000,
};

const ROLE_PAGE_LIMIT = 10;
const ROOT_KEY = "aiRoot";
const FOLDER_PREFIX = "aiFolder:";
const TREE_PREFIX = "aiTree:";
const ROOT_SLOT = "root";
const MEMORY_PAGE_KEY = "aiMemoryPage";
const MEMORY_AUTO_KEY = "aiMemoryAuto";
const LEGACY_TEMPLATES_KEY = "agentTemplates";
const ROLE_KINDS: Page["kind"][] = ["page", "row"];

type Slot = AiRole | typeof ROOT_SLOT;

function isRole(value: unknown): value is AiRole {
  return (AI_ROLES as readonly unknown[]).includes(value);
}

function explicitRole(page: Page): AiRole | null {
  return isRole(page.ai) ? page.ai : null;
}

function slotOf(book: Notebook, id: string): Slot | null {
  const slot = book.settings.get(TREE_PREFIX + id);

  return slot === ROOT_SLOT || isRole(slot) ? slot : null;
}

function pointerKey(slot: Slot) {
  return slot === ROOT_SLOT ? ROOT_KEY : FOLDER_PREFIX + slot;
}

function folderRole(book: Notebook, parent: string | null) {
  if (!parent) return null;
  const slot = slotOf(book, parent);

  if (isRole(slot)) return slot;

  return (
    AI_ROLES.find((role) => book.settings.get(pointerKey(role)) === parent) ??
    null
  );
}

export function pageRole(book: Notebook, page: Page | undefined) {
  if (!page || !ROLE_KINDS.includes(page.kind)) return null;
  if (page.ai !== undefined) return explicitRole(page);

  return folderRole(book, page.parent);
}

function livePage(book: Notebook, id: unknown) {
  if (typeof id !== "string" || !id) return undefined;
  const page = book.pages.get(id);

  return page && !page.archived && page.kind === "page" ? page : undefined;
}

function slotPages(book: Notebook, slot: Slot) {
  const registered = [...book.settings.keys()]
    .filter((key) => key.startsWith(TREE_PREFIX))
    .map((key) => key.slice(TREE_PREFIX.length))
    .filter((id) => slotOf(book, id) === slot);
  const ids = new Set<unknown>([
    ...registered,
    book.settings.get(pointerKey(slot)),
  ]);

  return [...ids].flatMap((id) => livePage(book, id) ?? []);
}

function firstById(pages: Page[]) {
  return pages.map((page) => page.id).sort()[0];
}

export function aiRootId(book: Notebook) {
  const pointed = livePage(book, book.settings.get(ROOT_KEY));

  return pointed?.id ?? firstById(slotPages(book, ROOT_SLOT)) ?? null;
}

function folderId(book: Notebook, root: string, role: AiRole) {
  const pointed = livePage(book, book.settings.get(pointerKey(role)));

  if (pointed?.parent === root) return pointed.id;

  return firstById(slotPages(book, role).filter((p) => p.parent === root));
}

type PageLookup = { get: (id: string) => Page | undefined };

export function exclusionSource(pages: PageLookup, id: unknown) {
  if (typeof id !== "string" || !id) return undefined;
  const seen = new Set<string>();
  let page = pages.get(id);

  while (page && !seen.has(page.id)) {
    if (page.aiExcluded) return page;
    seen.add(page.id);
    page = page.parent ? pages.get(page.parent) : undefined;
  }

  return undefined;
}

export function aiExcluded(book: Notebook, id: unknown) {
  return !!exclusionSource(book.pages, id);
}

function checker(pages: PageLookup, unknownIsExcluded: boolean) {
  const known = new Map<string, boolean>();

  return (id: unknown) => {
    if (typeof id !== "string" || !id) return false;
    const path = new Set<string>();
    let excluded = false;
    let next: string | null = id;

    while (next && !path.has(next)) {
      const settled = known.get(next);

      if (settled !== undefined) {
        excluded = settled;
        break;
      }

      const page = pages.get(next);

      if (!page) {
        excluded = unknownIsExcluded;
        break;
      }

      path.add(next);

      if (page.aiExcluded) {
        excluded = true;
        break;
      }

      next = page.parent;
    }

    for (const key of path) known.set(key, excluded);

    return excluded;
  };
}

export function exclusionChecker(pages: PageLookup) {
  return checker(pages, false);
}

export function sharingChecker(pages: PageLookup) {
  return checker(pages, true);
}

const MAX_DEPTH = 100;

export function aiProtected(book: Notebook, id: unknown) {
  if (typeof id !== "string" || !id) return false;
  const root = aiRootId(book);
  let page = book.pages.get(id);

  if (pageRole(book, page)) return true;

  for (let depth = 0; page && depth < MAX_DEPTH; depth++) {
    if (page.id === root || slotOf(book, page.id)) return true;
    page = page.parent ? book.pages.get(page.parent) : undefined;
  }

  return false;
}

export function rolePages(book: Notebook, role: AiRole) {
  const excluded = exclusionChecker(book.pages);

  return [...book.pages.values()]
    .filter((p) => !p.archived && pageRole(book, p) === role && !excluded(p.id))
    .sort((a, b) => book.editedAt(b) - book.editedAt(a));
}

function claim(book: Notebook, id: string, slot: Slot) {
  const { settings } = book;

  if (settings.get(TREE_PREFIX + id) !== slot)
    settings.set(TREE_PREFIX + id, slot);
  if (settings.get(pointerKey(slot)) !== id) settings.set(pointerKey(slot), id);
}

function liveChildren(book: Notebook, parent: string) {
  return [...book.pages.values()].filter(
    (page) => page.parent === parent && !page.archived,
  );
}

async function mergeInto(book: Notebook, from: string, into: string) {
  const children = liveChildren(book, from);
  const movable = children.filter((c) => mayMove(book.pages, c.id, into));
  const keptOut = aiExcluded(book, from) && !aiExcluded(book, into);
  const patch = keptOut ? { parent: into, aiExcluded: true } : { parent: into };

  for (const child of movable) await book.change(child.id, patch);
  book.settings.delete(TREE_PREFIX + from);
  if (movable.length === children.length)
    await book.change(from, { archived: Date.now() });
}

async function mergeSlot(book: Notebook, pages: Page[], slot: Slot) {
  const kept = firstById(pages);

  if (!kept) return null;
  for (const page of pages)
    if (page.id !== kept) await mergeInto(book, page.id, kept);
  claim(book, kept, slot);

  return kept;
}

export async function mergeAiTrees(book: Notebook) {
  await book.pages.whole();
  const root = await mergeSlot(book, slotPages(book, ROOT_SLOT), ROOT_SLOT);

  if (!root) return;

  for (const role of AI_ROLES) {
    const folders = slotPages(book, role).filter((p) => p.parent === root);

    await mergeSlot(book, folders, role);
  }
}

async function ensureAiRoot(book: Notebook, t: T) {
  const existing = aiRootId(book);

  if (existing) {
    claim(book, existing, ROOT_SLOT);

    return existing;
  }

  const root = book.add(t("aiTree"), "page", null);

  await book.change(root.id, { icon: "✨" });
  claim(book, root.id, ROOT_SLOT);

  return root.id;
}

function ensureFolder(book: Notebook, root: string, role: AiRole, t: T) {
  const id =
    folderId(book, root, role) ??
    book.add(t(ROLE_LABELS[role]), "page", root).id;

  claim(book, id, role);

  return id;
}

export async function ensureAiTree(book: Notebook, t: T) {
  await mergeAiTrees(book);
  const root = await ensureAiRoot(book, t);

  return Object.fromEntries(
    AI_ROLES.map((role) => [role, ensureFolder(book, root, role, t)]),
  ) as Record<AiRole, string>;
}

export async function ensureRoleFolder(book: Notebook, role: AiRole, t: T) {
  return (await ensureAiTree(book, t))[role];
}

function homeText(t: T, folders: Record<AiRole, string>) {
  const links = AI_ROLES.map(
    (role) =>
      "- [" +
      t(ROLE_LABELS[role]) +
      "](" +
      pageLink(folders[role]) +
      ") – " +
      t(ROLE_HINTS[role]),
  );

  return [t("aiHomeIntro"), "", ...links].join("\n");
}

export async function prepareAiHome(book: Notebook, t: T) {
  const folders = await ensureAiTree(book, t);
  const root = aiRootId(book);

  if (!root) throw Error("AI page unavailable");
  const entry = await book.load(root);

  if (!markdown(entry).trim()) {
    writeMarkdown(entry, homeText(t, folders));
    await book.change(root, {});
  }

  await book.flush();

  return root;
}

export async function setAiRole(
  book: Notebook,
  id: string,
  role: AiRole | null,
) {
  const page = book.pages.get(id);

  if (!page || !ROLE_KINDS.includes(page.kind)) throw Error("Invalid page");
  await book.change(id, { ai: role ?? "" });
}

export async function createRolePage(
  book: Notebook,
  role: AiRole,
  t: T,
  title = "",
  text = "",
): Promise<Entry> {
  const folder = await ensureRoleFolder(book, role, t);
  const entry = book.add(title.slice(0, 200), "page", folder);

  if (text) writeMarkdown(entry, text);
  await book.change(entry.id, { ai: role });
  await book.flush();

  return entry;
}

export async function pageText(book: Notebook, id: string, limit: number) {
  const page = book.pages.get(id);

  if (!page || page.archived || !ROLE_KINDS.includes(page.kind)) return null;
  if (aiExcluded(book, id)) return null;
  const full = markdown(await book.load(id)).trim();
  const text = full.slice(0, Math.max(0, limit));

  return {
    id,
    title: page.title,
    text,
    truncated: text.length < full.length,
  };
}

export async function roleContext(book: Notebook, role: AiRole) {
  const result: ContextPage[] = [];
  let remaining = ROLE_BUDGETS[role];

  for (const page of rolePages(book, role).slice(0, ROLE_PAGE_LIMIT)) {
    if (remaining <= 0) break;
    const loaded = await pageText(book, page.id, remaining);

    if (!loaded?.text) continue;
    remaining -= loaded.text.length;
    result.push(loaded);
  }

  return result;
}

export function memoryAuto(book: Notebook) {
  return book.settings.get(MEMORY_AUTO_KEY) === true;
}

export function setMemoryAuto(book: Notebook, on: boolean) {
  book.settings.set(MEMORY_AUTO_KEY, on);
}

export async function memoryPage(book: Notebook, t: T) {
  const known = book.pages.get(String(book.settings.get(MEMORY_PAGE_KEY)));
  const usable = known && !known.archived && pageRole(book, known) === "memory";

  if (usable && !aiExcluded(book, known.id)) return book.load(known.id);
  if (aiExcluded(book, await ensureRoleFolder(book, "memory", t)))
    throw Error("The memory folder is excluded from AI");
  const entry = await createRolePage(book, "memory", t, t("aiMemoryLearned"));

  book.settings.set(MEMORY_PAGE_KEY, entry.id);

  return entry;
}

function legacyText(value: Record<string, unknown>) {
  return [value.instructions, value.prompt]
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim().slice(0, ROLE_BUDGETS.template))
    .filter(Boolean)
    .join("\n\n");
}

export async function migrateTemplates(book: Notebook, t: T) {
  const stored = book.settings.get(LEGACY_TEMPLATES_KEY);

  if (stored === undefined) return;
  book.settings.delete(LEGACY_TEMPLATES_KEY);
  if (!Array.isArray(stored)) return;

  for (const value of stored.slice(0, 50)) {
    if (!value || typeof value !== "object") continue;
    const raw = value as Record<string, unknown>;
    const title = typeof raw.name === "string" ? raw.name.trim() : "";
    const text = legacyText(raw);

    if (title && text) await createRolePage(book, "template", t, title, text);
  }
}
