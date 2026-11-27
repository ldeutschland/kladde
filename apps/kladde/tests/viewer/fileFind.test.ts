import { describe, expect, it } from "vitest";
import {
  fileMatches,
  firstFrom,
  pageMarks,
  type FileMatch,
} from "../../src/viewer/fileFind";
import type { FoundBox } from "../../src/viewer/foundMarks";

const LINE: FoundBox = [0.1, 0.2, 0.3, 0.04];
const NEXT_LINE: FoundBox = [0.1, 0.25, 0.2, 0.04];
const MAX_MATCHES = 1000;
const MAX_PAGE = 100_000;

function match(page: number, ...boxes: FoundBox[]): FileMatch {
  return { page, boxes };
}

describe("matches from the backend", () => {
  it("keeps the page and the boxes of each match", () => {
    const answer = [
      { page: 0, boxes: [LINE, NEXT_LINE] },
      { page: 3, boxes: [] },
    ];

    expect(fileMatches(answer)).toEqual([match(0, LINE, NEXT_LINE), match(3)]);
  });

  it("drops matches without a small whole page number", () => {
    const answer = [
      { page: -1, boxes: [LINE] },
      { page: 1.5, boxes: [LINE] },
      { page: "2", boxes: [LINE] },
      { page: MAX_PAGE, boxes: [LINE] },
      { boxes: [LINE] },
      null,
      "page",
      { page: 4, boxes: [LINE] },
    ];

    expect(fileMatches(answer)).toEqual([match(4, LINE)]);
  });

  it("drops boxes that leave the page or have the wrong shape", () => {
    const boxes = [
      LINE,
      [0.1, 0.2, 0.3],
      [0.1, 0.2, 1.5, 0.04],
      [-0.1, 0.2, 0.3, 0.04],
      ["0.1", 0.2, 0.3, 0.04],
      NEXT_LINE,
    ];

    expect(fileMatches([{ page: 0, boxes }])).toEqual([
      match(0, LINE, NEXT_LINE),
    ]);
  });

  it("returns nothing for an answer that is not a list", () => {
    for (const answer of [null, undefined, {}, "matches", 3])
      expect(fileMatches(answer)).toEqual([]);
  });

  it("keeps at most a thousand matches", () => {
    const answer = Array.from({ length: MAX_MATCHES + 500 }, (_, page) => ({
      page,
      boxes: [LINE],
    }));

    expect(fileMatches(answer)).toHaveLength(MAX_MATCHES);
  });
});

describe("where finding starts", () => {
  const matches = [
    match(1, LINE),
    match(3, LINE),
    match(3, NEXT_LINE),
    match(7, LINE),
  ];

  it("starts at the first match on or after the page in view", () => {
    expect(firstFrom(matches, 0)).toBe(0);
    expect(firstFrom(matches, 2)).toBe(1);
    expect(firstFrom(matches, 3)).toBe(1);
    expect(firstFrom(matches, 4)).toBe(3);
  });

  it("starts over at the first match behind the last one", () => {
    expect(firstFrom(matches, 8)).toBe(0);
    expect(firstFrom([], 5)).toBe(0);
  });
});

describe("marks per page", () => {
  it("groups the boxes by page and sets the current match apart", () => {
    const marks = pageMarks(
      [match(0, LINE), match(2, LINE), match(2, NEXT_LINE)],
      2,
    );

    expect(marks.get(0)).toEqual({ boxes: [LINE], current: [] });
    expect(marks.get(2)).toEqual({ boxes: [LINE], current: [NEXT_LINE] });
    expect(marks.has(1)).toBe(false);
  });

  it("keeps every line of a match that wraps", () => {
    const marks = pageMarks([match(4, LINE, NEXT_LINE)], 0);

    expect(marks.get(4)).toEqual({ boxes: [], current: [LINE, NEXT_LINE] });
  });

  it("lists the page of a match that has no box", () => {
    expect(pageMarks([match(5)], 0).get(5)).toEqual({
      boxes: [],
      current: [],
    });
  });
});
