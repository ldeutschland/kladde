import { writeMarkdown } from "../notebook/content";
import { markdownForAi, memoryPage, sharingChecker } from "./aiPages";
import { startRun, stopRun, streamTurn } from "./assistant";
import { completeLocally, localFailure } from "./localModel";
import {
  MEMORY_SYSTEM,
  cleanMemory,
  memoryChanges,
  memoryRequest,
} from "./prompts";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { keepBefore } from "../versions/versions";

export interface MemoryResult {
  page: string;
  changed: boolean;
  cost: number;
  added: string[];
  removed: string[];
}

const LOCAL_EXCHANGE_TEXT = 1200;

function memoryMessages(current: string, question: string, answer: string) {
  return [
    { role: "system", content: MEMORY_SYSTEM },
    { role: "user", content: memoryRequest(current, question, answer) },
  ];
}

async function saveMemory(
  book: Notebook,
  entry: Entry,
  current: string,
  answer: { content: string; cost: number },
): Promise<MemoryResult> {
  const next = cleanMemory(answer.content, current);

  if (next) {
    await keepBefore(book, entry, "ai");
    writeMarkdown(entry, next);
    await book.change(entry.id, {});
    await book.flush();
  }

  const changes = next
    ? memoryChanges(current, next)
    : { added: [], removed: [] };

  return { page: entry.id, changed: !!next, cost: answer.cost, ...changes };
}

async function localMemory(
  book: Notebook,
  t: T,
  current: string,
  exchange: { question: string; answer: string },
) {
  const messages = memoryMessages(
    current,
    exchange.question.slice(0, LOCAL_EXCHANGE_TEXT),
    exchange.answer.slice(0, LOCAL_EXCHANGE_TEXT),
  );

  try {
    return await completeLocally(book.id, messages, () => {});
  } catch (error) {
    throw Error(localFailure(error, t), { cause: error });
  }
}

export async function rememberExchange(
  book: Notebook,
  t: T,
  question: string,
  answer: string,
  onDevice = false,
): Promise<MemoryResult> {
  const entry = await memoryPage(book, t);
  const current = markdownForAi(entry, sharingChecker(book.pages));

  if (onDevice) {
    const content = await localMemory(book, t, current, { question, answer });

    return saveMemory(book, entry, current, { content, cost: 0 });
  }

  const run = await startRun(book.id);

  try {
    const turn = await streamTurn(
      run,
      memoryMessages(current, question, answer),
      [],
      () => {},
      () => false,
    );

    return await saveMemory(book, entry, current, turn);
  } finally {
    await stopRun(run);
  }
}
