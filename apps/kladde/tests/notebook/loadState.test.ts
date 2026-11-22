import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Notebook } from "../../src/notebook/notebook";

const native = vi.hoisted(() => ({
  replies: [] as ArrayBuffer[],
  calls: [] as Record<string, unknown>[],
}));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (_name: string, args: Record<string, unknown>) => {
    native.calls.push(args);

    return native.replies.shift() ?? new ArrayBuffer(0);
  }),
}));

const { loadState } = await import("../../src/notebook/notebook");
const { applyRemote } = await import("../../src/sync/sync");

function stamped(rev: number, data: Uint8Array = new Uint8Array()) {
  const bytes = new Uint8Array(8 + data.length);

  new DataView(bytes.buffer).setBigInt64(0, BigInt(rev), true);
  bytes.set(data, 8);

  return bytes.buffer;
}

function bookWith(doc: Y.Doc, rev: number) {
  const entry = { id: "page", doc, rev, kind: "page" as const };

  return {
    book: { id: "book", entries: new Map([["page", entry]]) },
    entry,
  };
}

beforeEach(() => {
  native.replies = [];
  native.calls = [];
});

describe("document state from the core", () => {
  it("tells missing, unchanged and new states apart", async () => {
    native.replies = [
      new ArrayBuffer(0),
      stamped(4),
      stamped(5, Uint8Array.of(9)),
    ];
    expect(await loadState("page", "book", "page", 4)).toBeNull();
    expect(await loadState("page", "book", "page", 4)).toEqual({
      rev: 4,
      data: null,
    });
    const fresh = await loadState("page", "book", "page", 4);

    expect(fresh?.rev).toBe(5);
    expect(Array.from(fresh?.data ?? [])).toEqual([9]);
    expect(native.calls[0]).toEqual({
      id: "page",
      space: "book",
      kind: "page",
      after: 4,
    });
  });

  it("refuses truncated or impossible revisions", async () => {
    native.replies = [new ArrayBuffer(3), stamped(0)];
    await expect(loadState("page", "book", "page", 0)).rejects.toThrow();
    await expect(loadState("page", "book", "page", 0)).rejects.toThrow();
  });

  it("skips documents the editor already shows", async () => {
    const { book, entry } = bookWith(new Y.Doc(), 7);

    native.replies = [stamped(7)];
    await applyRemote(book as unknown as Notebook, "page");
    expect(entry.rev).toBe(7);
    expect(native.calls[0].after).toBe(7);
  });

  it("applies newer states without lowering a revision saved meanwhile", async () => {
    const remote = new Y.Doc();

    remote.getMap("meta").set("title", "Von drüben");
    const { book, entry } = bookWith(new Y.Doc(), 3);

    native.replies = [stamped(5, Y.encodeStateAsUpdate(remote))];
    const applying = applyRemote(book as unknown as Notebook, "page");

    entry.rev = 6;
    await applying;
    expect(entry.rev).toBe(6);
    expect(entry.doc.getMap("meta").get("title")).toBe("Von drüben");
  });
});
