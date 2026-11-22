import { describe, expect, it, vi } from "vitest";
import type { blocks } from "../../src/notebook/content";

vi.mock("../../src/notebook/pageMarkdown", async (importOriginal) =>
  (await import("../support/plainContent")).plainPageMarkdown(
    await importOriginal(),
  ),
);

const { applyBlockOperations } = await import("../../src/ai/blockOperations");
const { plainText, paragraphs } = await import("../support/plainContent");

type Blocks = ReturnType<typeof blocks>;

function page(...texts: string[]): Blocks {
  return paragraphs(texts.join("\n\n")).map((block, index) => ({
    ...block,
    id: "b" + (index + 1),
  }));
}

function summary(all: Blocks) {
  return all.map((block) => block.id + ":" + plainText([block]));
}

describe("Block operations", () => {
  it("deletes and moves blocks by id", () => {
    const all = page("one", "two", "three");

    applyBlockOperations(all, [
      { action: "move", block_id: "b1", after: "b3" },
      { action: "delete", block_id: "b2" },
    ]);
    expect(summary(all)).toEqual(["b3:three", "b1:one"]);
  });

  it("keeps the id of a replaced block for the first new block", () => {
    const all = page("one", "two");

    applyBlockOperations(all, [
      { action: "replace", block_id: "b1", markdown: "first\n\nsecond" },
    ]);
    expect(summary(all).slice(0, 1)).toEqual(["b1:first"]);
    expect(all.map((block) => plainText([block]))).toEqual([
      "first",
      "second",
      "two",
    ]);
    expect(new Set(all.map((block) => block.id)).size).toBe(3);
  });

  it("inserts new blocks right after the given block", () => {
    const all = page("one", "two");

    applyBlockOperations(all, [
      { action: "insert_after", block_id: "b1", markdown: "a\n\nb" },
    ]);
    expect(all.map((block) => plainText([block]))).toEqual([
      "one",
      "a",
      "b",
      "two",
    ]);
  });

  it("sees the result of earlier operations in the same call", () => {
    const all = page("one");

    applyBlockOperations(all, [
      { action: "insert_after", block_id: "b1", markdown: "two" },
    ]);
    const added = all[1].id;

    applyBlockOperations(all, [
      { action: "move", block_id: "b1", after: added },
      { action: "delete", block_id: added },
    ]);
    expect(summary(all)).toEqual(["b1:one"]);
  });

  it("refuses unknown blocks, targets and actions", () => {
    const cases: [unknown, string][] = [
      [{ action: "delete", block_id: "missing" }, "Unknown block"],
      [{ action: "delete" }, "Unknown block"],
      [{ action: "move", block_id: "b1", after: "missing" }, "Invalid target"],
      [{ action: "move", block_id: "b1", after: "b1" }, "Invalid target"],
      [{ action: "move", block_id: "b1" }, "Invalid target"],
      [{ action: "rewrite", block_id: "b1" }, "Invalid operation"],
      [{ action: "__proto__", block_id: "b1" }, "Invalid operation"],
      ["delete b1", "Invalid object"],
      [["delete", "b1"], "Invalid object"],
    ];

    for (const [operation, message] of cases) {
      const all = page("one", "two");

      expect(
        () => applyBlockOperations(all, [operation]),
        JSON.stringify(operation),
      ).toThrow(message);
      expect(summary(all)).toEqual(["b1:one", "b2:two"]);
    }
  });

  it("asks for the delete action instead of empty replacement text", () => {
    const all = page("one");

    for (const markdown of ["", "  \n\t "])
      expect(() =>
        applyBlockOperations(all, [
          { action: "replace", block_id: "b1", markdown },
        ]),
      ).toThrow("Use the delete action to remove a block");
    expect(summary(all)).toEqual(["b1:one"]);
  });

  it("rejects replacement text that is missing, not text or too long", () => {
    const all = page("one");

    for (const markdown of [undefined, 5, "x".repeat(32001)])
      expect(() =>
        applyBlockOperations(all, [
          { action: "insert_after", block_id: "b1", markdown },
        ]),
      ).toThrow("Invalid text");
  });
});
