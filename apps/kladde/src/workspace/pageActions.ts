import type { Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { Ask } from "../ui/dialog";
import { setAiRole, type AiRole } from "../ai/aiPages";
import {
  IMAGE_TYPES,
  createNotebook,
  movePage,
  restorePage,
  savePageImage,
} from "./commands";
import { selectTitle } from "./TitleField";
import type { Overlays } from "./useOverlays";
import type { ImageKey, Toast } from "./types";

export interface WorkspaceContext {
  book: Notebook;
  t: T;
  ask: Ask;
  current: string | null;
  open: (target: string | null) => Promise<void>;
  show: (target: string | null) => Promise<boolean>;
  changeBook: (id?: string) => Promise<void>;
  overlays: Overlays;
  toast: (toast: Toast) => void;
}

export async function createPage(
  context: WorkspaceContext,
  kind: "page" | "database" = "page",
  parent: string | null = null,
) {
  const { book, t } = context;

  context.overlays.setPopup(null);
  const e = book.add(kind === "database" ? t("newDb") : "", kind, parent);

  await context.open(e.id);
  if (kind === "database") selectTitle();
}

export async function moveToTrash(context: WorkspaceContext, target: Page) {
  const { book, current } = context;

  context.overlays.setPopup(null);
  await book.trashBranch(target.id, Date.now());
  if (current && book.pages.get(current)?.archived) await context.open(null);
  context.toast({
    text: context.t("trashed"),
    undo: () => void restorePage(book, target.id),
  });
}

export async function duplicatePage(context: WorkspaceContext, target: string) {
  context.overlays.setPopup(null);
  const { copyPages } = await import("../notebook/copyPages");

  await context.open(
    await copyPages(context.book, context.book, target, false),
  );
}

export function renamePage(context: WorkspaceContext, target: Page) {
  const { setPopup } = context.overlays;

  if (target.id !== context.current) {
    setPopup((current) => current && { ...current, kind: "rename" });

    return;
  }

  setPopup(null);
  selectTitle();
}

export async function showHistory(context: WorkspaceContext, target: string) {
  context.overlays.setPopup(null);
  await context.book.flush();
  if (!(await context.show(target))) return;
  context.overlays.setModal("history");
}

export async function setPageImage(
  context: WorkspaceContext,
  key: ImageKey,
  target: string,
  file?: File,
) {
  if (!file || !IMAGE_TYPES.includes(file.type)) return;
  context.overlays.setPopup(null);

  try {
    await savePageImage(context.book, key, target, file);
  } catch (problem) {
    context.toast({ text: String(problem) });
  }
}

export async function moveWithUndo(
  context: WorkspaceContext,
  moved: Page,
  parent: string | null,
) {
  context.toast(await movePage(context.book, context.t, moved, parent));
}

export async function newWorkspace(context: WorkspaceContext) {
  context.overlays.setPopup(null);
  const created = await createNotebook(context.book, context.ask, context.t);

  if (created) await context.changeBook(created);
}

export async function switchBook(context: WorkspaceContext, target: string) {
  context.overlays.setPopup(null);
  if (target === context.book.id) return;
  await context.book.flush();
  await context.changeBook(target);
}

export async function openRow(context: WorkspaceContext, rowId: string) {
  const { book } = context;
  const parent = book.pages.get(rowId)?.parent;

  if (!parent) return;
  const db = await book.load(parent);

  context.overlays.setRow({ entry: await book.load(rowId), db });
}

export async function assignAiRole(
  context: WorkspaceContext,
  target: Page,
  role: AiRole | null,
) {
  context.overlays.setPopup(null);

  try {
    await setAiRole(context.book, target.id, role);
  } catch (error) {
    context.toast({ text: String(error) });
  }
}
