import { markdown, writeMarkdown } from "../notebook/content";
import { pageLink } from "../notebook/links";
import type { Entry, Notebook, Page } from "../notebook/notebook";
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
const MEMORY_PAGE_KEY = "aiMemoryPage";
const MEMORY_AUTO_KEY = "aiMemoryAuto";
const LEGACY_TEMPLATES_KEY = "agentTemplates";
const ROLE_KINDS: Page["kind"][] = ["page", "row"];

function explicitRole(page: Page): AiRole | null {
  return (AI_ROLES as readonly unknown[]).includes(page.ai)
    ? (page.ai as AiRole)
    : null;
}

function folderRole(book: Notebook, parent: string | null) {
  if (!parent) return null;

  return (
    AI_ROLES.find(
      (role) => book.settings.get(FOLDER_PREFIX + role) === parent,
    ) ?? null
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

export function aiRootId(book: Notebook) {
  return livePage(book, book.settings.get(ROOT_KEY))?.id ?? null;
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
    if (page.id === root) return true;
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

export function ensureAiRoot(book: Notebook, t: T) {
  const existing = aiRootId(book);

  if (existing) return existing;
  const root = book.add(t("aiTree"), "page", null);

  void book.change(root.id, { icon: "✨" });
  book.settings.set(ROOT_KEY, root.id);

  return root.id;
}

function ensureFolder(book: Notebook, root: string, role: AiRole, t: T) {
  const key = FOLDER_PREFIX + role;
  const existing = livePage(book, book.settings.get(key));

  if (existing && existing.parent === root) return existing.id;
  const folder = book.add(t(ROLE_LABELS[role]), "page", root);

  book.settings.set(key, folder.id);

  return folder.id;
}

export function ensureAiTree(book: Notebook, t: T) {
  const root = ensureAiRoot(book, t);

  return Object.fromEntries(
    AI_ROLES.map((role) => [role, ensureFolder(book, root, role, t)]),
  ) as Record<AiRole, string>;
}

export function ensureRoleFolder(book: Notebook, role: AiRole, t: T) {
  return ensureAiTree(book, t)[role];
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
  const folders = ensureAiTree(book, t);
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
  const entry = book.add(
    title.slice(0, 200),
    "page",
    ensureRoleFolder(book, role, t),
  );

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
  if (aiExcluded(book, ensureRoleFolder(book, "memory", t)))
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
