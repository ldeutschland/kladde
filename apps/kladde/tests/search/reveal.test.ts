import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import { findFileBlock, fold } from "../../src/search/reveal";
import { foundBoxes } from "../../src/viewer/foundMarks";
import { searchTerms } from "../../src/search/search";
import { Highlight } from "../../src/search/Highlight";

const FILE = "f1ecb4dd-0000-4000-8000-000000000000";

function block(id: string, url = "", children: unknown[] = []) {
  return { id, props: { url }, children } as never;
}

function marked(text: string, query: string) {
  const parts = Highlight({ text, query });

  if (!Array.isArray(parts)) return [];

  return parts
    .filter(isValidElement)
    .map((part) => (part.props as { children: string }).children);
}

describe("search terms", () => {
  it("splits a query into at most sixteen words without quotes", () => {
    expect(searchTerms(' "Ende  2027" Vertrag ')).toEqual([
      "Ende",
      "2027",
      "Vertrag",
    ]);
    expect(searchTerms(Array(20).fill("a").join(" "))).toHaveLength(16);
  });

  it("marks every term, longest first, without treating them as patterns", () => {
    expect(marked("Wartungsvertrag bis Ende 2027.", "wart 2027")).toEqual([
      "Wart",
      "2027",
    ]);
    expect(marked("Wartung", "wart wartung")).toEqual(["Wartung"]);
    expect(marked("a.b (c)", "(c) .")).toEqual([".", "(c)"]);
    expect(Highlight({ text: "frei", query: "  " })).toBe("frei");
  });
});

describe("reveal", () => {
  it("folds case and accents for matching", () => {
    expect(fold("Müller ÉTÉ")).toBe("muller ete");
  });

  it("finds a nested file block by its file id", () => {
    const tree = [
      block("a"),
      block("b", "", [block("c", "kladde-file:" + FILE)]),
    ];

    expect(findFileBlock(tree, FILE)).toMatchObject({ id: "c" });
    expect(findFileBlock(tree, FILE.replace("f1", "f2"))).toBeUndefined();
  });

  it("keeps only boxes inside the page", () => {
    expect(
      foundBoxes([
        [0.1, 0.2, 0.3, 0.4],
        [0.1, 0.2, 0.3],
        [0.1, 0.2, 0.3, 1.4],
        [Number.NaN, 0, 0, 0],
        "box",
      ]),
    ).toEqual([[0.1, 0.2, 0.3, 0.4]]);
    expect(foundBoxes(null)).toEqual([]);
    expect(foundBoxes(Array(80).fill([0, 0, 1, 1]))).toHaveLength(64);
  });
});
