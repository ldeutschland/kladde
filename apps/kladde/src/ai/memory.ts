import { markdown, writeMarkdown } from "../notebook/content";
import { memoryPage } from "./aiPages";
import { startRun, stopRun, streamTurn } from "./assistant";
import {
  MEMORY_SYSTEM,
  cleanMemory,
  memoryChanges,
  memoryRequest,
} from "./prompts";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { keepBefore } from "../versions/versions";

export interface MemoryResult {
  page: string;
  changed: boolean;
  cost: number;
  added: string[];
  removed: string[];
}

export async function rememberExchange(
  book: Notebook,
  t: T,
  question: string,
  answer: string,
): Promise<MemoryResult> {
  const entry = await memoryPage(book, t);
  const current = markdown(entry);
  const run = await startRun(book.id);

  try {
    const turn = await streamTurn(
      run,
      [
        { role: "system", content: MEMORY_SYSTEM },
        { role: "user", content: memoryRequest(current, question, answer) },
      ],
      [],
      () => {},
      () => false,
    );
    const next = cleanMemory(turn.content, current);

    if (next) {
      await keepBefore(book, entry, "ai");
      writeMarkdown(entry, next);
      await book.change(entry.id, {});
      await book.flush();
    }

    const changes = next
      ? memoryChanges(current, next)
      : { added: [], removed: [] };

    return { page: entry.id, changed: !!next, cost: turn.cost, ...changes };
  } finally {
    await stopRun(run);
  }
}
