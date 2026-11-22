import { describe, expect, it } from "vitest";
import type { Notebook, Page } from "../../src/notebook/notebook";
import {
  expandPage,
  togglePage,
  treeChildren,
  visibleRows,
  type TreeChildren,
} from "../../src/workspace/treeRows";

function page(id: string, overrides: Partial<Page> = {}): Page {
  return {
    id,
    title: id,
    kind: "page",
    parent: null,
    order: 0,
    icon: "",
    favorite: false,
    archived: null,
    updated: 0,
    cover: "",
    wide: false,
    ...overrides,
  };
}

function fakeBook(pages: Page[], settings: Record<string, unknown> = {}) {
  return {
    pages: new Map(pages.map((item) => [item.id, item])),
    settings: new Map(Object.entries(settings)),
    editedAt: (item: Page) => item.updated,
  } as unknown as Notebook;
}

function shown(rows: { page: Page; depth: number }[]) {
  return rows.map((row) => `${row.page.id}@${row.depth}`);
}

const OPTIONS = {
  root: null,
  hidden: null,
  closed: new Set<string>(),
  limit: 100,
};

describe("tree children", () => {
  it("leaves out archived pages, chats and database rows", () => {
    const book = fakeBook([
      page("kept"),
      page("old", { archived: 1 }),
      page("chat", { kind: "chat" }),
      page("row", { kind: "row", parent: "kept" }),
    ]);
    const children = treeChildren(book, "newest");

    expect(children.get(null)?.map((item) => item.id)).toEqual(["kept"]);
    expect(children.get("kept")).toBeUndefined();
  });

  it("lifts pages with a missing or archived parent to the top level", () => {
    const book = fakeBook([
      page("orphan", { parent: "gone" }),
      page("bin", { archived: 5 }),
      page("inBin", { parent: "bin" }),
    ]);
    const roots = treeChildren(book, "title").get(null)!;

    expect(roots.map((item) => item.id)).toEqual(["inBin", "orphan"]);
  });

  it("breaks a parent cycle so every page stays reachable exactly once", () => {
    const book = fakeBook([
      page("b", { parent: "c" }),
      page("c", { parent: "a" }),
      page("a", { parent: "b" }),
    ]);
    const { rows } = visibleRows(treeChildren(book, "newest"), OPTIONS);

    expect(shown(rows)).toEqual(["a@0", "c@1", "b@2"]);
  });

  it("sorts siblings by the chosen order", () => {
    const book = fakeBook([
      page("x", { order: 1, title: "Zebra" }),
      page("y", { order: 3, title: "apfel" }),
      page("z", { order: 2, title: "Birne" }),
    ]);
    const ids = (sort: "newest" | "oldest" | "title") =>
      treeChildren(book, sort)
        .get(null)!
        .map((item) => item.id);

    expect(ids("newest")).toEqual(["y", "z", "x"]);
    expect(ids("oldest")).toEqual(["x", "z", "y"]);
    expect(ids("title")).toEqual(["y", "z", "x"]);
  });
});

describe("visible rows", () => {
  const children: TreeChildren = new Map([
    [null, [page("a"), page("b")]],
    ["a", [page("a1"), page("a2")]],
    ["a1", [page("a1x")]],
  ]);

  it("lists pages depth first with their nesting level", () => {
    const { rows, more } = visibleRows(children, OPTIONS);

    expect(shown(rows)).toEqual(["a@0", "a1@1", "a1x@2", "a2@1", "b@0"]);
    expect(more).toBe(false);
  });

  it("hides the children of closed pages and the hidden page", () => {
    const { rows } = visibleRows(children, {
      ...OPTIONS,
      hidden: "b",
      closed: new Set(["a1"]),
    });

    expect(shown(rows)).toEqual(["a@0", "a1@1", "a2@1"]);
  });

  it("stops at the limit and reports that more rows exist", () => {
    const { rows, more } = visibleRows(children, { ...OPTIONS, limit: 2 });

    expect(shown(rows)).toEqual(["a@0", "a1@1"]);
    expect(more).toBe(true);
  });

  it("starts below the given root", () => {
    const { rows } = visibleRows(children, { ...OPTIONS, root: "a" });

    expect(shown(rows)).toEqual(["a1@0", "a1x@1", "a2@0"]);
  });

  it("terminates on a cyclic children map", () => {
    const looping: TreeChildren = new Map([
      [null, [page("a")]],
      ["a", [page("b")]],
      ["b", [page("a")]],
    ]);

    expect(shown(visibleRows(looping, OPTIONS).rows)).toEqual(["a@0", "b@1"]);
  });
});

describe("closed pages", () => {
  it("toggles a page closed and open again", () => {
    const book = fakeBook([page("a")]);

    togglePage(book, "a");
    expect(book.settings.get("treeClosed")).toEqual(["a"]);
    togglePage(book, "a");
    expect(book.settings.get("treeClosed")).toEqual([]);
  });

  it("forgets closed pages that no longer exist when saving", () => {
    const book = fakeBook([page("a"), page("b")], {
      treeClosed: ["gone", "a", 42],
    });

    togglePage(book, "b");
    expect(book.settings.get("treeClosed")).toEqual(["a", "b"]);
  });

  it("does not write settings when expanding a page that is already open", () => {
    const stored = ["a"];
    const book = fakeBook([page("a"), page("b")], { treeClosed: stored });

    expandPage(book, "b");
    expect(book.settings.get("treeClosed")).toBe(stored);
    expandPage(book, "a");
    expect(book.settings.get("treeClosed")).toEqual([]);
  });
});
