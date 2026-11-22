import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Entry, Kind } from "../../src/notebook/notebook";

vi.mock("../../src/notebook/content", async (importOriginal) =>
  (await import("../support/plainContent")).plainContent(
    await importOriginal(),
  ),
);

const { blockReview, keepOriginalBlocks } =
  await import("../../src/ai/blockReview");
const { blockIds, paragraphTexts, writeParagraphs } =
  await import("../support/agentFixture");

function entry(items: [string, string][], kind: Kind = "page"): Entry {
  const written: Entry = { id: "p", kind, rev: 1, doc: new Y.Doc() };

  writeParagraphs(written, items);

  return written;
}

const original: [string, string][] = [
  ["a", "one"],
  ["b", "two"],
  ["c", "three"],
];

describe("Block review", () => {
  it("has nothing to review for new pages, databases or unchanged pages", () => {
    expect(blockReview(null, entry(original))).toEqual([]);
    expect(blockReview(entry(original), entry(original, "database"))).toEqual(
      [],
    );
    expect(blockReview(entry(original), entry(original))).toEqual([]);
  });

  it("lists changed, added and removed blocks with text before and after", () => {
    const draft = entry([
      ["a", "one"],
      ["b", "zwei"],
      ["c", "three"],
      ["d", "four"],
    ]);

    expect(blockReview(entry(original), draft)).toEqual([
      { id: "b", before: "two", after: "zwei" },
      { id: "d", before: "", after: "four" },
    ]);
    expect(
      blockReview(
        entry(original),
        entry([
          ["a", "one"],
          ["c", "three"],
        ]),
      ),
    ).toEqual([
      { id: "b", before: "two", after: "" },
      { id: "c", before: "three", after: "three" },
    ]);
  });

  it("reviews rows like pages", () => {
    expect(
      blockReview(entry(original, "row"), entry([["a", "uno"]], "row")),
    ).toHaveLength(3);
  });
});

describe("Keeping rejected blocks", () => {
  it("restores the original text of a rejected change", () => {
    const draft = entry([
      ["a", "eins"],
      ["b", "zwei"],
      ["c", "three"],
    ]);

    keepOriginalBlocks(entry(original), draft, new Set(["b"]));
    expect(paragraphTexts(draft)).toEqual(["eins", "two", "three"]);
    expect(draft.doc.getMap("meta").get("text")).toBe("eins\n\ntwo\n\nthree");
  });

  it("drops a rejected new block", () => {
    const draft = entry([...original, ["x", "injected"]]);

    keepOriginalBlocks(entry(original), draft, new Set(["x"]));
    expect(blockIds(draft)).toEqual(["a", "b", "c"]);
  });

  it("puts a rejected deletion back behind its previous neighbour", () => {
    const draft = entry([
      ["c", "three"],
      ["a", "one"],
    ]);

    keepOriginalBlocks(entry(original), draft, new Set(["b"]));
    expect(blockIds(draft)).toEqual(["c", "a", "b"]);
  });

  it("puts a rejected first block back at the top", () => {
    const draft = entry([
      ["b", "two"],
      ["c", "three"],
    ]);

    keepOriginalBlocks(entry(original), draft, new Set(["a"]));
    expect(paragraphTexts(draft)).toEqual(["one", "two", "three"]);
  });

  it("leaves the draft untouched when no rejected block is involved", () => {
    const draft = entry([["a", "eins"]]);
    const before = Y.encodeStateAsUpdate(draft.doc);

    keepOriginalBlocks(entry(original), draft, new Set(["zzz"]));
    expect(Y.encodeStateAsUpdate(draft.doc)).toEqual(before);
  });
});
