import { describe, expect, it, vi } from "vitest";
import type { PageMarks } from "../../src/viewer/foundMarks";
import type { FileFind } from "../../src/viewer/useFileFind";

vi.mock("../../src/platform/native", () => ({ command: vi.fn() }));

const { shownMarks } = await import("../../src/viewer/useFileFind");

const OTHER: PageMarks = { boxes: [[0.2, 0.4, 0.3, 0.05]], current: [] };
const CURRENT: PageMarks = { boxes: [], current: [[0.2, 0.6, 0.3, 0.05]] };
const REVEALED: PageMarks = { boxes: [[0.1, 0.1, 0.2, 0.05]], current: [] };

function find(state: Partial<FileFind>) {
  const base = {
    open: false,
    touched: false,
    query: "",
    marks: new Map<number, PageMarks>(),
  };

  return { ...base, ...state } as unknown as FileFind;
}

describe("marks shown on a page", () => {
  it("shows the matches of each page and centers only the current one", () => {
    const finding = find({
      open: true,
      touched: true,
      query: "betrag",
      marks: new Map([
        [1, OTHER],
        [2, CURRENT],
      ]),
    });

    expect(shownMarks(finding, 1, REVEALED)).toEqual({
      marks: OTHER,
      centered: false,
    });
    expect(shownMarks(finding, 2, undefined)).toEqual({
      marks: CURRENT,
      centered: true,
    });
    expect(shownMarks(finding, 3, REVEALED)).toBeUndefined();
  });

  it("shows the search hit the file was opened for until find is used", () => {
    expect(shownMarks(find({}), 0, REVEALED)).toEqual({
      marks: REVEALED,
      centered: true,
    });
    expect(shownMarks(find({}), 0, undefined)).toBeUndefined();
  });

  it("does not bring that hit back once find was used", () => {
    const closed = find({ touched: true, query: "betrag" });
    const blank = find({ open: true, touched: true, query: "  " });

    expect(shownMarks(closed, 0, REVEALED)).toBeUndefined();
    expect(shownMarks(blank, 0, REVEALED)).toBeUndefined();
  });
});
