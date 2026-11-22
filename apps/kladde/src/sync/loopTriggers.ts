import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyRemote } from "./sync";
import { validHints, want, type LoopState } from "./loopState";
import { schedule, urgent } from "./loopRun";

const POLL_MS = 30000;
const POLL_LIVE_MS = 300000;
const AFTER_EDIT_MS = 800;
const EDIT_MAX_WAIT_MS = 5000;
const REMOTE_MS = 150;
const RETURN_MS = 300;

interface RemoteEvent {
  space: string;
  docs: [string, number][];
  full: boolean;
}

interface SpaceEvent {
  space: string;
  id?: string;
  live?: boolean;
  problem?: string | null;
}

export function poll(state: LoopState) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(
    () => {
      if (!document.hidden) {
        want(state, true);
        schedule(state, 0);
      }

      poll(state);
    },
    state.relayLive ? POLL_LIVE_MS : POLL_MS,
  );
}

export function edited(state: LoopState) {
  const { book } = state;

  if (book.saves === state.seenSaves) return;
  state.seenSaves = book.saves;
  state.editStart ||= Date.now();
  clearTimeout(state.editTimer);
  const left = state.editStart + EDIT_MAX_WAIT_MS - Date.now();

  state.editTimer = setTimeout(
    () => {
      state.editStart = 0;
      schedule(state, 0);
    },
    Math.max(0, Math.min(AFTER_EDIT_MS, left)),
  );
}

export function becameVisible(state: LoopState) {
  if (document.hidden) return schedule(state, 0);
  want(state, true);
  urgent(state, RETURN_MS);
}

export function cameOnline(state: LoopState) {
  want(state, true);
  urgent(state, 0);
}

function remote(state: LoopState, event: RemoteEvent) {
  if (event.space !== state.book.id || !validHints(event.docs)) return;
  want(state, event.full === true, event.docs);
  urgent(state, event.full ? 0 : REMOTE_MS);
}

function changed(state: LoopState, event: SpaceEvent) {
  const { book } = state;

  if (event.space !== book.id || typeof event.id !== "string") return;
  void applyRemote(book, event.id)
    .then(() => book.notify())
    .catch(() => {});
}

function liveness(state: LoopState, event: SpaceEvent) {
  if (event.space !== state.book.id || typeof event.live !== "boolean") return;
  if (state.relayLive === event.live) return;
  state.relayLive = event.live;
  poll(state);
}

function filed(state: LoopState, event: SpaceEvent) {
  if (event.space !== state.book.id) return;
  const files = event.problem === "full" ? "full" : "files";
  const problem = event.problem ? files : null;

  state.hooks.status((previous) => ({ ...previous, files: problem }));
}

export function listenToRelay(state: LoopState) {
  if (!isTauri()) return [];

  return [
    listen<RemoteEvent>("sync-remote", (event) => remote(state, event.payload)),
    listen<SpaceEvent>("sync-doc", (event) => changed(state, event.payload)),
    listen<SpaceEvent>("sync-live", (event) => liveness(state, event.payload)),
    listen<SpaceEvent>("sync-files", (event) => filed(state, event.payload)),
  ];
}
