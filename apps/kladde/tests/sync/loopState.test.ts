import { describe, expect, it } from "vitest";
import type { Notebook } from "../../src/notebook/notebook";
import {
  createLoopState,
  restore,
  validHints,
  want,
} from "../../src/sync/loopState";

const MAX_HINTS = 4096;

function state() {
  const loop = createLoopState({ id: "book", saves: 7 } as Notebook, {
    status: () => {},
    slow: () => {},
    result: () => {},
  });

  loop.need.full = false;

  return loop;
}

describe("sync loop state", () => {
  it("starts live with a full run pending and the current save count", () => {
    const loop = createLoopState({ id: "book", saves: 7 } as Notebook, {
      status: () => {},
      slow: () => {},
      result: () => {},
    });

    expect(loop.need.full).toBe(true);
    expect(loop.seenSaves).toBe(7);
    expect(loop.live).toBe(true);
    expect(loop.dueAt).toBe(Infinity);
  });

  it("accepts only bounded lists of document and safe sequence pairs", () => {
    expect(validHints([])).toBe(true);
    expect(validHints([["doc", 0]])).toBe(true);
    expect(
      validHints(Array.from({ length: MAX_HINTS }, (_, i) => [`d${i}`, i])),
    ).toBe(true);
    const hostile: unknown[] = [
      null,
      "doc",
      { 0: ["doc", 1], length: 1 },
      [["doc"]],
      [[1, 1]],
      [["doc", 1.5]],
      [["doc", "1"]],
      [["doc", NaN]],
      [["doc", Number.MAX_SAFE_INTEGER + 1]],
      [null],
      Array.from({ length: MAX_HINTS + 1 }, (_, i) => [`d${i}`, i]),
    ];

    for (const docs of hostile) expect(validHints(docs)).toBe(false);
  });

  it("keeps the highest sequence per document and never lowers it", () => {
    const loop = state();

    want(loop, false, [
      ["a", 5],
      ["b", 1],
    ]);
    want(loop, false, [
      ["a", 3],
      ["b", 4],
    ]);
    expect([...loop.need.docs]).toEqual([
      ["a", 5],
      ["b", 4],
    ]);
  });

  it("keeps a requested full run once asked for", () => {
    const loop = state();

    want(loop, true);
    want(loop, false, [["a", 1]]);
    expect(loop.need.full).toBe(true);
  });

  it("falls back to one full run instead of tracking too many documents", () => {
    const loop = state();

    want(
      loop,
      false,
      Array.from({ length: MAX_HINTS + 1 }, (_, i) => [`d${i}`, i]),
    );
    expect(loop.need.full).toBe(true);
    expect(loop.need.docs.size).toBe(0);
  });

  it("merges a missed run back into what is still needed", () => {
    const loop = state();

    want(loop, false, [["a", 2]]);
    restore(loop, {
      full: true,
      docs: new Map([
        ["a", 9],
        ["c", 1],
      ]),
    });
    expect(loop.need.full).toBe(true);
    expect(Object.fromEntries(loop.need.docs)).toEqual({ a: 9, c: 1 });
  });
});
