import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Notebook } from "../../src/notebook/notebook";
import type { SyncStatus } from "../../src/sync/sync";

const relay = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  applied: [] as string[],
  fail: false,
}));
const run = vi.hoisted(() => ({
  schedule: [] as number[],
  urgent: [] as number[],
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (name: string, handler: (event: { payload: unknown }) => void) => {
      relay.handlers.set(name, handler);

      return () => {};
    },
  ),
}));
vi.mock("../../src/sync/sync", () => ({
  applyRemote: vi.fn(async (_book: unknown, id: string) => {
    if (relay.fail) throw Error("broken");
    relay.applied.push(id);
  }),
}));
vi.mock("../../src/sync/loopRun", () => ({
  schedule: (_state: unknown, delay: number) => void run.schedule.push(delay),
  urgent: (_state: unknown, delay: number) => void run.urgent.push(delay),
}));

const { createLoopState } = await import("../../src/sync/loopState");
const { becameVisible, cameOnline, edited, listenToRelay, poll } =
  await import("../../src/sync/loopTriggers");

const POLL_MS = 30000;
const POLL_LIVE_MS = 300000;
const AFTER_EDIT_MS = 800;
const EDIT_MAX_WAIT_MS = 5000;

let documentState: { hidden: boolean };

function setup() {
  let status = { files: null } as SyncStatus;
  const book = { id: "book", saves: 0, notify: vi.fn() };
  const state = createLoopState(book as unknown as Notebook, {
    status: (update) => (status = update(status)),
    slow: () => {},
    result: () => {},
  });

  state.need.full = false;

  return { book, state, status: () => status };
}

function emit(name: string, payload: unknown) {
  relay.handlers.get(name)!({ payload });
}

beforeEach(() => {
  vi.useFakeTimers();
  documentState = { hidden: false };
  vi.stubGlobal("document", documentState);
  relay.handlers.clear();
  relay.applied = [];
  relay.fail = false;
  run.schedule = [];
  run.urgent = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("edit trigger", () => {
  it("ignores notifications without a new save", () => {
    const { state } = setup();

    edited(state);
    vi.advanceTimersByTime(EDIT_MAX_WAIT_MS);
    expect(run.schedule).toEqual([]);
  });

  it("syncs a short pause after the last edit", () => {
    const { book, state } = setup();

    book.saves = 1;
    edited(state);
    vi.advanceTimersByTime(AFTER_EDIT_MS - 1);
    expect(run.schedule).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(run.schedule).toEqual([0]);
  });

  it("syncs during continuous typing after the maximum wait", () => {
    const { book, state } = setup();

    for (let elapsed = 0; elapsed < EDIT_MAX_WAIT_MS; elapsed += 500) {
      book.saves++;
      edited(state);
      vi.advanceTimersByTime(500);
    }

    expect(run.schedule).toEqual([0]);
    expect(state.editStart).toBe(0);
  });
});

describe("visibility and network triggers", () => {
  it("runs pending work without a full sync while hidden", () => {
    const { state } = setup();

    documentState.hidden = true;
    becameVisible(state);
    expect(run.schedule).toEqual([0]);
    expect(state.need.full).toBe(false);
  });

  it("asks for a full sync when the app comes back or the network returns", () => {
    const visible = setup();

    becameVisible(visible.state);
    expect(visible.state.need.full).toBe(true);
    const online = setup();

    cameOnline(online.state);
    expect(online.state.need.full).toBe(true);
    expect(run.urgent).toEqual([300, 0]);
  });

  it("polls slowly while the relay pushes changes and skips hidden windows", () => {
    const { state } = setup();

    poll(state);
    vi.advanceTimersByTime(POLL_MS);
    expect(run.schedule).toEqual([0]);
    documentState.hidden = true;
    vi.advanceTimersByTime(POLL_MS);
    expect(run.schedule).toEqual([0]);
    documentState.hidden = false;
    state.relayLive = true;
    vi.advanceTimersByTime(POLL_MS);
    expect(run.schedule).toEqual([0, 0]);
    vi.advanceTimersByTime(POLL_LIVE_MS - 1);
    expect(run.schedule).toEqual([0, 0]);
    vi.advanceTimersByTime(1);
    expect(run.schedule).toEqual([0, 0, 0]);
  });
});

describe("relay events", () => {
  it("ignores events for other notebooks and malformed hints", async () => {
    const { state, status } = setup();

    await Promise.all(listenToRelay(state));
    emit("sync-remote", { space: "other", docs: [["a", 1]], full: true });
    emit("sync-remote", { space: "book", docs: [["a", "1"]], full: true });
    emit("sync-remote", { space: "book", docs: "a", full: false });
    emit("sync-files", { space: "other", problem: "full" });
    emit("sync-doc", { space: "other", id: "a" });
    emit("sync-doc", { space: "book", id: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(run.urgent).toEqual([]);
    expect(state.need.full).toBe(false);
    expect(status().files).toBeNull();
    expect(relay.applied).toEqual([]);
  });

  it("collects document hints and syncs full requests at once", async () => {
    const { state } = setup();

    await Promise.all(listenToRelay(state));
    emit("sync-remote", { space: "book", docs: [["a", 3]], full: false });
    emit("sync-remote", { space: "book", docs: [["a", 2]], full: "yes" });
    expect(state.need.full).toBe(false);
    emit("sync-remote", { space: "book", docs: [], full: true });
    expect(run.urgent).toEqual([150, 0, 0]);
    expect(state.need.full).toBe(true);
    expect([...state.need.docs]).toEqual([["a", 3]]);
  });

  it("switches the polling pace only when liveness actually changes", async () => {
    const { state } = setup();

    await Promise.all(listenToRelay(state));
    poll(state);
    emit("sync-live", { space: "book", live: "true" });
    expect(state.relayLive).toBe(false);
    emit("sync-live", { space: "book", live: true });
    vi.advanceTimersByTime(POLL_MS);
    expect(run.schedule).toEqual([]);
    vi.advanceTimersByTime(POLL_LIVE_MS - POLL_MS);
    expect(run.schedule).toEqual([0]);
  });

  it("reports full storage apart from other attachment problems", async () => {
    const { state, status } = setup();

    await Promise.all(listenToRelay(state));
    emit("sync-files", { space: "book", problem: "full" });
    expect(status().files).toBe("full");
    emit("sync-files", { space: "book", problem: "upload failed" });
    expect(status().files).toBe("files");
    emit("sync-files", { space: "book", problem: null });
    expect(status().files).toBeNull();
  });

  it("applies arrived documents and survives failures", async () => {
    const { book, state } = setup();

    await Promise.all(listenToRelay(state));
    emit("sync-doc", { space: "book", id: "a" });
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.applied).toEqual(["a"]);
    expect(book.notify).toHaveBeenCalledOnce();
    relay.fail = true;
    emit("sync-doc", { space: "book", id: "b" });
    await vi.advanceTimersByTimeAsync(0);
    expect(book.notify).toHaveBeenCalledOnce();
  });
});
