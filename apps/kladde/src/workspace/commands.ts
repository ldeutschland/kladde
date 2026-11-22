import { Notebook, type Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { Ask } from "../ui/dialog";
import { command } from "../platform/native";
import { saveFile } from "../files/attachments";
import { download } from "../files/download";
import type { ImageKey, Toast } from "./types";

export const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];
export const COVER_TONES = ["sand", "sky", "rose", "sage", "slate", "night"];
export const STARTER_ICONS = [
  "📄",
  "📝",
  "📌",
  "💡",
  "📚",
  "🗂️",
  "🧭",
  "🌱",
  "⭐",
  "🎯",
  "🧪",
  "📅",
];

export function pick(list: string[]) {
  return list[Math.floor(Math.random() * list.length)];
}

export function firstLetter(name: string) {
  return (Array.from(name.trim())[0] ?? "K").toUpperCase();
}

export async function restorePage(book: Notebook, target: string) {
  const restored = book.pages.get(target);

  if (!restored) return;
  const parent = restored.parent ? book.pages.get(restored.parent) : null;

  if (restored.kind !== "row" && parent?.archived)
    await book.change(target, { parent: null });
  await book.trashBranch(target, null);
}

export async function erasePage(book: Notebook, ask: Ask, t: T, target: Page) {
  const confirmed = await ask(t("eraseQuestion"), undefined, {
    detail: t("eraseDetail").replace("{title}", target.title || t("untitled")),
    action: t("erase"),
    danger: true,
  });

  if (!confirmed) return;
  await book.erase(book.branch(target.id), (doomed) =>
    command("forget", { id: doomed }),
  );
}

export async function exportPage(book: Notebook, t: T, target: Page) {
  const loaded = await book.load(target.id);
  const { markdown } = await import("../notebook/content");

  download(
    (target.title || t("untitled")) + ".md",
    markdown(loaded),
    "text/markdown",
  );
}

export async function savePageImage(
  book: Notebook,
  key: ImageKey,
  target: string,
  file: File,
) {
  const owner = await book.load(target);
  const reference = await saveFile(book, owner, file);

  await book.change(target, { [key]: reference });
}

export async function movePage(
  book: Notebook,
  t: T,
  moved: Page,
  parent: string | null,
): Promise<Toast> {
  const before = { parent: moved.parent, order: moved.order };

  await book.change(moved.id, { parent, order: Date.now() });
  const place = parent
    ? book.pages.get(parent)?.title || t("untitled")
    : t("root");

  return {
    text: t("movedTo").replace("{place}", place),
    undo: () => void book.change(moved.id, before),
  };
}

interface Feedback {
  open: (target: string) => Promise<void>;
  toast: (toast: Toast) => void;
}

export async function importPages(
  book: Notebook,
  t: T,
  files: File[],
  parent: string | null,
  feedback: Feedback,
) {
  try {
    const { importFiles, importable } = await import("../files/importFiles");

    if (!files.some(importable)) {
      feedback.toast({ text: t("importUnsupported") });

      return;
    }

    const first = await importFiles(book, files, parent);

    if (first) await feedback.open(first);
  } catch (problem) {
    feedback.toast({ text: String(problem) });
  }
}

export async function createNotebook(book: Notebook, ask: Ask, t: T) {
  const name = await ask(t("newBook"), "", {
    placeholder: t("workspaceName"),
    action: t("create"),
  });

  if (!name) return null;
  await book.flush();

  return (await Notebook.create(name)).id;
}

export async function clipWebPage(
  book: Notebook,
  ask: Ask,
  t: T,
  feedback: Feedback,
) {
  const address = await ask(t("clipPrompt"), "", {
    placeholder: "https://",
    detail: t("clipHint"),
    action: t("clipSave"),
  });

  if (!address) return;
  feedback.toast({ text: t("clipSaving"), busy: true });

  try {
    const { saveClip } = await import("../capture/clipper");
    const row = await saveClip(book, address, t);

    feedback.toast(null);
    await feedback.open(row.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    feedback.toast({ text: t("clipFailed").replace("{error}", reason) });
  }
}
