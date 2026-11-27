import type { Notebook } from "../notebook/notebook";
import type { SyncResult, SyncStatus } from "./sync";

const MAX_HINTS = 4096;

type Timer = ReturnType<typeof setTimeout> | undefined;

export type StatusUpdate = (previous: SyncStatus) => SyncStatus;

export interface SyncHooks {
  status: (update: StatusUpdate) => void;
  slow: (slow: boolean) => void;
  result: (result: SyncResult) => void;
  arrived?: () => void;
}

export interface Need {
  full: boolean;
  docs: Map<string, number>;
}

export interface LoopState {
  book: Notebook;
  hooks: SyncHooks;
  live: boolean;
  running: boolean;
  queued: boolean;
  relayLive: boolean;
  failures: number;
  contended: number;
  retryAt: number;
  dueAt: number;
  othersDue: number;
  editStart: number;
  seenSaves: number;
  watched: string | null | undefined;
  need: Need;
  soon: Timer;
  editTimer: Timer;
  pollTimer: Timer;
}

export function emptyNeed(): Need {
  return { full: false, docs: new Map() };
}

export function createLoopState(book: Notebook, hooks: SyncHooks): LoopState {
  return {
    book,
    hooks,
    live: true,
    running: false,
    queued: false,
    relayLive: false,
    failures: 0,
    contended: 0,
    retryAt: 0,
    dueAt: Infinity,
    othersDue: 0,
    editStart: 0,
    seenSaves: book.saves,
    watched: undefined,
    need: { full: true, docs: new Map() },
    soon: undefined,
    editTimer: undefined,
    pollTimer: undefined,
  };
}

export function validHints(docs: unknown): docs is [string, number][] {
  return (
    Array.isArray(docs) &&
    docs.length <= MAX_HINTS &&
    docs.every(
      (hint) =>
        Array.isArray(hint) &&
        typeof hint[0] === "string" &&
        Number.isSafeInteger(hint[1]),
    )
  );
}

export function want(
  state: LoopState,
  full: boolean,
  docs: [string, number][] = [],
) {
  const { need } = state;

  need.full ||= full;
  for (const [doc, seq] of docs)
    need.docs.set(doc, Math.max(seq, need.docs.get(doc) ?? seq));
  if (need.docs.size > MAX_HINTS) state.need = { full: true, docs: new Map() };
}

export function restore(state: LoopState, missed: Need) {
  want(state, missed.full, [...missed.docs.entries()]);
}
