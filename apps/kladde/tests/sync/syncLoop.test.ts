import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SYNC_OFF,
  type SyncRequest,
  type SyncStatus,
} from "../../src/sync/sync";
import type { Notebook } from "../../src/notebook/notebook";

const native = vi.hoisted(() => ({
  account: ["https://sync.example.org", "test", "book", "device"] as
    string[] | null,
  watched: [] as (string | null)[],
}));
const calls = vi.hoisted(() => ({
  requests: [] as SyncRequest[],
  outcomes: [] as (string | null)[],
  retries: [] as string[][],
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
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

      if (outcome === "throw") throw Error("sync:offline");

      return {
        changed: [],
        removed: [],
        rescue: [],
        failed: [],
        retry: calls.retries.shift() ?? [],
        waiting: 0,
        stopped: outcome,
        recovered: [],
      };
    },
  ),
}));

const { startSyncLoop } = await import("../../src/sync/syncLoop");

function fakeBook() {
  const listeners = new Set<() => void>();

  return {
    id: "book",
    saves: 0,
    subscribe(fn: () => void) {
      listeners.add(fn);

      return () => listeners.delete(fn);
    },
    edit() {
      this.saves++;
      for (const fn of listeners) fn();
    },
  };
}

function start(book = fakeBook()) {
  let status: SyncStatus = SYNC_OFF;
  const stop = startSyncLoop(book as unknown as Notebook, {
    status: (update) => (status = update(status)),
    slow: () => {},
    result: () => {},
  });

  return { book, stop, status: () => status };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { hidden: false }),
  );
  vi.stubGlobal("window", new EventTarget());
  native.account = ["https://sync.example.org", "test", "book", "device"];
  native.watched = [];
  calls.requests = [];
  calls.outcomes = [];
  calls.retries = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sync loop", () => {
  it("starts with a full run and watches the notebook", async () => {
    const loop = start();

    await vi.advanceTimersByTimeAsync(0);
    expect(calls.requests).toEqual([{ full: true, hints: [] }]);
    expect(native.watched).toEqual(["book"]);
    expect(loop.status().phase).toBe("synced");
    loop.stop();
  });

  it("sends edits quickly but not on every keystroke", async () => {
    const loop = start();

    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 20; i++) {
      loop.book.edit();
      await vi.advanceTimersByTimeAsync(400);
    }

    expect(calls.requests.length).toBe(2);
    expect(calls.requests[1]).toEqual({ full: false, hints: [] });
    loop.book.edit();
    await vi.advanceTimersByTimeAsync(799);
    expect(calls.requests.length).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.requests.length).toBe(3);
    loop.stop();
  });

  it("hides one network hiccup, retries and keeps the pending full run", async () => {
    calls.outcomes = ["offline", "throw", null];
    const loop = start();

    await vi.advanceTimersByTimeAsync(0);
    expect(loop.status().phase).toBe("off");
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.requests.length).toBe(2);
    expect(calls.requests[1].full).toBe(true);
    expect(loop.status().phase).toBe("offline");
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls.requests.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.requests.length).toBe(3);
    expect(calls.requests[2].full).toBe(true);
    expect(loop.status().phase).toBe("synced");
    loop.stop();
  });

  it("does not hammer the relay with edits while it is unreachable", async () => {
    calls.outcomes = ["offline", "offline", "offline"];
    const loop = start();

    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 10; i++) {
      loop.book.edit();
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(calls.requests.length).toBe(1);
    loop.stop();
  });

  it("retries soon after write contention without showing a problem", async () => {
    calls.retries = [["page"]];
    const loop = start();

    await vi.advanceTimersByTimeAsync(0);
    expect(loop.status().phase).toBe("synced");
    await vi.advanceTimersByTimeAsync(999);
    expect(calls.requests.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.requests).toEqual([
      { full: true, hints: [] },
      { full: false, hints: [] },
    ]);
    await vi.advanceTimersByTimeAsync(20000);
    expect(calls.requests.length).toBe(2);
    loop.stop();
  });

  it("stops quick retries when contention persists", async () => {
    calls.retries = Array.from({ length: 10 }, () => ["page"]);
    const loop = start();

    await vi.advanceTimersByTimeAsync(29000);
    expect(calls.requests.length).toBe(6);
    expect(loop.status().phase).toBe("synced");
    loop.stop();
  });

  it("stops watching when the notebook has no sync account", async () => {
    native.account = null;
    const loop = start();

    await vi.advanceTimersByTimeAsync(0);
    expect(calls.requests).toEqual([]);
    expect(native.watched).toEqual([null]);
    expect(loop.status()).toEqual(SYNC_OFF);
    loop.stop();
  });
});
