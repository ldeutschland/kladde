import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { rememberExchange, type MemoryResult } from "../ai/memory";
import type { Item, MemoryMark } from "./types";

export function savingMark(): MemoryMark {
  return {
    state: "saving",
    page: "",
    added: [],
    removed: [],
    cost: 0,
    error: "",
  };
}

function savedMark(result: MemoryResult): MemoryMark {
  return {
    state: "saved",
    page: result.page,
    added: result.added,
    removed: result.removed,
    cost: result.cost,
    error: "",
  };
}

export function withMemory(items: Item[], memory: MemoryMark | undefined) {
  const last = items[items.length - 1];

  if (!last || last.role !== "assistant") return items;

  return [...items.slice(0, -1), { ...last, memory }];
}

export async function rememberReply(
  book: Notebook,
  t: T,
  question: string,
  answer: string,
  onDevice = false,
): Promise<MemoryMark | undefined> {
  try {
    const result = await rememberExchange(book, t, question, answer, onDevice);

    return result.changed ? savedMark(result) : undefined;
  } catch (error) {
    return { ...savingMark(), state: "failed", error: String(error) };
  }
}
