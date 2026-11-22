import type { AiChange } from "../ai/aiUndo";
import type { SearchHit } from "../search/search";
import type { WebSource } from "../ai/assistant";

export interface Item {
  role: "user" | "assistant";
  text: string;
  steps?: string[];
  cost?: number;
  error?: string;
  sources?: WebSource[];
  shared?: string[];
  citations?: SearchHit[];
  memory?: MemoryMark;
  changes?: AiChange[];
  undone?: boolean;
}

export interface UndoNote {
  index: number;
  text: string;
}

export interface MemoryMark {
  state: "saving" | "saved" | "failed";
  page: string;
  added: string[];
  removed: string[];
  cost: number;
  error: string;
}

export function hasAppliedChanges(item: Item) {
  return !!item.changes?.length && !item.undone;
}

export type AiView = "chat" | "history" | "settings" | "library";
