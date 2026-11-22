import { describe, expect, it } from "vitest";
import {
  NO_PAGES,
  moveItem,
  originalPages,
  pageLabel,
} from "../../src/viewer/pdfDraft";
import type { T } from "../../src/locale/locale";

describe("pdf page drafts", () => {
  it("starts with every page unturned and unmarked in source order", () => {
    const pages = originalPages({
      sizes: [
        [1, 1],
        [2, 2],
      ],
      editable: true,
    });

    expect(pages).toEqual([
      { source: 0, turn: 0, marks: [] },
      { source: 1, turn: 0, marks: [] },
    ]);
    expect(originalPages(null)).toBe(NO_PAGES);
    expect(originalPages(undefined)).toBe(NO_PAGES);
  });

  it("moves a page forward or backward without changing the original list", () => {
    const list = ["a", "b", "c", "d"];

    expect(moveItem(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  it("labels pages counting from one", () => {
    const t = ((key: string) =>
      key === "pageNumber" ? "Page {page}" : key) as T;

    expect(pageLabel(t, 0)).toBe("Page 1");
  });
});
