import type { Notebook } from "../notebook/notebook";
import { createLoopState, type SyncHooks } from "./loopState";
import { schedule } from "./loopRun";
import {
  becameVisible,
  cameOnline,
  edited,
  listenToRelay,
  poll,
} from "./loopTriggers";

export function startSyncLoop(book: Notebook, hooks: SyncHooks) {
  const state = createLoopState(book, hooks);
  const visibility = () => becameVisible(state);
  const online = () => cameOnline(state);
  const listeners = listenToRelay(state);
  const unsubscribe = book.subscribe(() => edited(state));

  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("online", online);
  poll(state);
  schedule(state, 0);

  return () => {
    state.live = false;
    clearTimeout(state.soon);
    clearTimeout(state.editTimer);
    clearTimeout(state.pollTimer);
    unsubscribe();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("online", online);
    for (const attached of listeners) void attached.then((stop) => stop());
  };
}
