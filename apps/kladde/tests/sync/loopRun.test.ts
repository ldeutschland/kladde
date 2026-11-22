import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SYNC_OFF,
  type SyncRequest,
  type SyncStatus,
} from "../../src/sync/sync";
import type { Notebook } from "../../src/notebook/notebook";

const native = vi.hoisted(() => ({
  account: ["https://sync.example.org", "u", "book", "d"] as string[] | null,
  watched: [] as (string | null)[],
}));
const calls = vi.hoisted(() => ({
  requests: [] as SyncRequest[],
  outcomes: [] as (string | Error | null)[],
  delay: 0,
}));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "account_info") return native.account;
    if (name === "sync_watch") native.watched.push(args.space as string | null);

    return null;
  }),
}));
vi.mock("../../src/sync/sync", async (original) => ({
  ...(await original<typeof import("../../src/sync/sync")>()),
  syncBook: vi.fn(
    async (_book: unknown, _space: unknown, request: SyncRequest) => {
      calls.requests.push(request);
      const outcome = calls.outcomes.shift() ?? null;

      if (calls.delay)
        await new Promise((resolve) => setTimeout(resolve, calls.delay));
      if (outcome instanceof Error) throw outcome;

      return {
        changed: [],
        removed: [],
        rescue: [],
        failed: [],
        retry: [],
        waiting: 0,
        stopped: outcome,
        recovered: [],
      };
    },
  ),
}));

const { createLoopState, want } = await import("../../src/sync/loopState");
const { schedule, urgent } = await import("../../src/sync/loopRun");

const SLOW_MS = 1500;

function setup() {
  let status: SyncStatus = SYNC_OFF;
  const slow: boolean[] = [];
  const state = createLoopState({ id: "book", saves: 0 } as Notebook, {
    status: (update) => (status = update(status)),
    slow: (value) => slow.push(value),
    result: () => {},
  });

  return { state, slow, status: () => status };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  native.account = ["https://sync.example.org", "u", "book", "d"];
  native.watched = [];
  calls.requests = [];
  calls.outcomes = [];
  calls.delay = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("run scheduling", () => {
  it("never postpones a run that is already due sooner", async () => {
    const { state } = setup();

    schedule(state, 100);
    schedule(state, 5000);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.requests).toHaveLength(1);
  });

  it("moves a pending run forward when asked for an earlier one", async () => {
    const { state } = setup();

    schedule(state, 5000);
    schedule(state, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.requests).toHaveLength(1);
  });

  it("waits for the retry time unless the trigger is urgent", async () => {
    const { state } = setup();

    state.retryAt = Date.now() + 10000;
    schedule(state, 0);
    await vi.advanceTimersByTimeAsync(9999);
    expect(calls.requests).toHaveLength(0);
    urgent(state, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.requests).toHaveLength(1);
    expect(state.retryAt).toBe(0);
  });

  it("does nothing once the loop has stopped", async () => {
    const { state } = setup();

    schedule(state, 50);
    state.live = false;
    schedule(state, 0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.requests).toEqual([]);
  });

  it("queues a second run while one is in flight instead of overlapping", async () => {
    const { state } = setup();

    calls.delay = 1000;
    schedule(state, 0);
    await vi.advanceTimersByTimeAsync(0);
    want(state, false, [["late", 4]]);
    schedule(state, 0);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(510);
    expect(calls.requests).toHaveLength(2);
    expect(calls.requests[1]).toEqual({ full: false, hints: [["late", 4]] });
  });
});

describe("status transitions", () => {
  it("shows an expired login at once and returns to synced after it is fixed", async () => {
    const { state, status } = setup();

    calls.outcomes = ["auth", null];
    schedule(state, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(status()).toMatchObject({ phase: "auth", problem: "auth" });
    expect(state.failures).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.requests).toHaveLength(2);
    expect(status()).toMatchObject({ phase: "synced", problem: null });
    expect(state.failures).toBe(0);
  });

  it("keeps the hints of a failed run for the retry", async () => {
    const { state } = setup();

    state.need.full = false;
    want(state, false, [["page", 9]]);
    calls.outcomes = [new Error("sync:offline"), null];
    schedule(state, 0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.requests).toEqual([
      { full: false, hints: [["page", 9]] },
      { full: false, hints: [["page", 9]] },
    ]);
  });

  it("does not retry or count attachment problems as failures", async () => {
    const { state, status } = setup();

    calls.outcomes = ["files"];
    schedule(state, 0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(calls.requests).toHaveLength(1);
    expect(state.failures).toBe(0);
    expect(status().problem).toBe("files");
  });

  it("shows unknown errors with their text and a growing back-off", async () => {
    const { state, status } = setup();

    calls.outcomes = [new Error("boom"), new Error("boom")];
    schedule(state, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(status()).toMatchObject({ phase: "error", detail: "boom" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(state.failures).toBe(2);
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls.requests).toHaveLength(2);
  });

  it("turns sync off and forgets failures when the account disappears", async () => {
    const { state, status } = setup();

    calls.outcomes = ["auth"];
    schedule(state, 0);
    await vi.advanceTimersByTimeAsync(0);
    native.account = null;
    await vi.advanceTimersByTimeAsync(2000);
    expect(status()).toEqual(SYNC_OFF);
    expect(state.failures).toBe(0);
    expect(native.watched).toEqual(["book", null]);
  });

  it("flags slow runs and clears the flag afterwards", async () => {
    const { state, slow } = setup();

    calls.delay = SLOW_MS + 500;
    schedule(state, 0);
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(slow).toEqual([true]);
    await vi.advanceTimersByTimeAsync(500);
    expect(slow).toEqual([true, false]);
  });
});
