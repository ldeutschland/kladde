import { command } from "../platform/native";
import {
  SYNC_OFF,
  retryDelay,
  settle,
  statusFromError,
  statusFromReport,
  syncBook,
  type SyncProblem,
  type SyncResult,
} from "./sync";
import {
  emptyNeed,
  restore,
  type LoopState,
  type Need,
  type StatusUpdate,
} from "./loopState";

const SLOW_MS = 1500;
const CONTENDED_MS = 1000;
const MAX_CONTENDED = 5;

type Account = [string, string, string, string] | null;

export function schedule(state: LoopState, delay: number) {
  if (!state.live) return;
  const target = Math.max(Date.now() + delay, state.retryAt);

  if (state.soon !== undefined && state.dueAt <= target) return;
  clearTimeout(state.soon);
  state.dueAt = target;
  state.soon = setTimeout(() => void run(state), target - Date.now());
}

export function urgent(state: LoopState, delay: number) {
  state.retryAt = 0;
  schedule(state, delay);
}

function watch(state: LoopState, space: string | null) {
  if (state.watched === space) return;
  state.watched = space;
  void command("sync_watch", { space }).catch(() => {
    state.watched = undefined;
  });
}

function contend(state: LoopState, result: SyncResult) {
  state.contended = result.retry?.length ? state.contended + 1 : 0;
  const { contended } = state;

  if (contended === 0 || contended > MAX_CONTENDED) return;
  schedule(
    state,
    Math.round(CONTENDED_MS * contended * (1 + Math.random() / 4)),
  );
}

function settled(
  state: LoopState,
  next: StatusUpdate,
  problem: SyncProblem | null,
) {
  state.failures = problem && problem !== "files" ? state.failures + 1 : 0;
  const count = state.failures;

  state.hooks.status((previous) => settle(next(previous), previous, count));
  if (state.failures)
    state.retryAt = Date.now() + retryDelay(state.failures, problem);

  return state.failures === 0;
}

async function syncAccount(state: LoopState, current: Need) {
  const { book, hooks } = state;
  const slow = setTimeout(() => hooks.slow(true), SLOW_MS);

  try {
    const request = { full: current.full, hints: [...current.docs] };
    const result = await syncBook(book, book.id, request);

    if (!state.live) return true;
    hooks.result(result);
    contend(state, result);
    const problem = statusFromReport(result, SYNC_OFF).problem;

    return settled(
      state,
      (status) => statusFromReport(result, status),
      problem,
    );
  } finally {
    clearTimeout(slow);
    hooks.slow(false);
  }
}

async function syncOnce(state: LoopState, current: Need) {
  const { book } = state;
  const account = await command<Account>("account_info", { space: book.id });

  if (!account) {
    watch(state, null);
    state.failures = 0;
    state.hooks.status(() => SYNC_OFF);

    return true;
  }

  watch(state, book.id);

  return syncAccount(state, current);
}

async function attempt(state: LoopState, current: Need) {
  try {
    return await syncOnce(state, current);
  } catch (error) {
    if (!state.live) return true;
    const problem = statusFromError(error, SYNC_OFF).problem;

    return settled(state, (status) => statusFromError(error, status), problem);
  }
}

async function run(state: LoopState) {
  state.soon = undefined;
  state.dueAt = Infinity;
  if (!state.live) return;

  if (state.running) {
    state.queued = true;

    return;
  }

  state.running = true;
  const current = state.need;

  state.need = emptyNeed();

  try {
    if (!(await attempt(state, current))) restore(state, current);
  } finally {
    state.running = false;

    if (state.live && (state.queued || state.failures)) {
      state.queued = false;
      schedule(state, 0);
    }
  }
}
