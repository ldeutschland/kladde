import { MAX_TITLE, Notebook } from "../notebook/notebook";
import { command } from "../platform/native";
import type { T, Word } from "../locale/locale";
import { readableError } from "../sync/accountTypes";

export interface BookRemoval {
  id: string;
  fromServer: boolean;
  syncsHere: boolean;
}

const DELETE_PROBLEMS: [reason: string, word: Word][] = [
  ["Notebook has unsynced changes", "deleteBookUnsynced"],
  ["The last notebook on this device stays", "deleteBookLast"],
];

export function cleanBookName(input: string) {
  const name = input.replace(/\p{Cc}/gu, " ").trim();

  return Array.from(name).slice(0, MAX_TITLE).join("");
}

export async function renameBook(current: Notebook, id: string, input: string) {
  const name = cleanBookName(input);

  if (!name) return false;
  const book = id === current.id ? current : await Notebook.openManifest(id);

  if (book.title === name) return false;
  book.rename(name);
  await book.flush();

  return true;
}

export async function deleteBook(current: Notebook, removal: BookRemoval) {
  const space = removal.id;

  if (space === current.id) await current.flush();
  if (removal.fromServer) await command("remove_space", { space });
  else if (removal.syncsHere)
    await command("sync_now", { space }).catch(() => null);
  await command("delete_space", { space });
}

export function deletionProblem(error: unknown, name: string, t: T) {
  const text = String(error);
  const known = DELETE_PROBLEMS.find(([reason]) => text.includes(reason));

  if (known) return t(known[1]);

  return (
    t("deleteBookFailed").replace("{name}", name) +
    " " +
    readableError(error, t)
  );
}
