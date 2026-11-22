import { describe, expect, it, vi } from "vitest";
import type { DragEvent } from "react";
import type { Notebook, Page } from "../../src/notebook/notebook";
import {
  canPlace,
  carriesFiles,
  carriesPage,
  carriesTab,
  droppedPage,
  placeAt,
  placeAtEnd,
  placePage,
} from "../../src/ui/dragDrop";

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

function fakeBook(pages: Page[], sort = "newest") {
  const book = {
    pages: new Map(pages.map((item) => [item.id, item])),
    settings: new Map([["pageSort", sort]]),
    editedAt: (item: Page) => item.updated,
    change: vi.fn(async () => {}),
  };

  return { book, asBook: book as unknown as Notebook };
}

function dragOver(clientY: number, types: string[] = [], data = "") {
  return {
    clientY,
    dataTransfer: { types, getData: () => data },
  } as unknown as DragEvent;
}

function row(top: number, height: number) {
  return {
    getBoundingClientRect: () => ({ top, height }),
  } as unknown as Element;
}

describe("drop position", () => {
  it("splits a row into before, inside and after by a quarter at each edge", () => {
    const target = row(100, 40);

    expect(placeAt(dragOver(109), target, true)).toBe("before");
    expect(placeAt(dragOver(110), target, true)).toBe("inside");
    expect(placeAt(dragOver(130), target, true)).toBe("inside");
    expect(placeAt(dragOver(131), target, true)).toBe("after");
  });

  it("splits a row in half when nesting is not allowed", () => {
    const target = row(100, 40);

    expect(placeAt(dragOver(119), target, false)).toBe("before");
    expect(placeAt(dragOver(120), target, false)).toBe("after");
  });

  it("stays defined for rows without height", () => {
    const flat = row(100, 0);

    expect(placeAt(dragOver(100), flat, true)).toBe("before");
    expect(placeAt(dragOver(101), flat, true)).toBe("after");
  });
});

describe("drag payloads", () => {
  it("recognises pages, tabs and files and tolerates a missing transfer", () => {
    const pageDrag = dragOver(0, ["text/kladde"]);
    const fileDrag = dragOver(0, ["Files"]);
    const empty = { dataTransfer: null } as unknown as DragEvent;

    expect(carriesPage(pageDrag)).toBe(true);
    expect(carriesTab(pageDrag)).toBe(false);
    expect(carriesFiles(fileDrag)).toBe(true);
    expect(carriesPage(empty) || carriesFiles(empty) || carriesTab(empty)).toBe(
      false,
    );
  });

  it("accepts dropped pages only when they exist, are not trashed and are not chats", () => {
    const { asBook } = fakeBook([
      page("ok"),
      page("old", { archived: 1 }),
      page("chat", { kind: "chat" }),
    ]);
    const drop = (id: string) => droppedPage(dragOver(0, [], id), asBook);

    expect(drop("ok")?.id).toBe("ok");
    expect(drop("old")).toBeNull();
    expect(drop("chat")).toBeNull();
    expect(drop("missing")).toBeNull();
    expect(drop("")).toBeNull();
  });
});

describe("placing pages", () => {
  const tree = () =>
    fakeBook([
      page("a"),
      page("a1", { parent: "a" }),
      page("a1x", { parent: "a1" }),
      page("db", { kind: "database" }),
      page("row", { kind: "row", parent: "db" }),
      page("bin", { archived: 1 }),
    ]);

  it("refuses moves into itself, a descendant, a database or the trash", () => {
    const { book, asBook } = tree();
    const get = (id: string) => book.pages.get(id)!;

    expect(canPlace(asBook, "a", get("a"), "inside")).toBe(false);
    expect(canPlace(asBook, "a", get("a1x"), "inside")).toBe(false);
    expect(canPlace(asBook, "a", get("a1x"), "after")).toBe(false);
    expect(canPlace(asBook, "a1", get("db"), "inside")).toBe(false);
    expect(canPlace(asBook, "a1", get("bin"), "inside")).toBe(false);
    expect(canPlace(asBook, "a1", get("db"), "after")).toBe(true);
  });

  it("never moves database rows or chats", () => {
    const { book, asBook } = tree();

    book.pages.set("chat", page("chat", { kind: "chat" }));
    expect(canPlace(asBook, "row", book.pages.get("a")!, "inside")).toBe(false);
    expect(canPlace(asBook, "chat", book.pages.get("a")!, "inside")).toBe(
      false,
    );
    expect(canPlace(asBook, "missing", book.pages.get("a")!, "after")).toBe(
      false,
    );
  });

  it("orders a page between its new neighbours when sorted newest first", async () => {
    const { book, asBook } = fakeBook([
      page("x", { order: 30 }),
      page("y", { order: 20 }),
      page("z", { order: 10 }),
      page("moved", { order: 99, parent: "x" }),
    ]);
    const get = (id: string) => book.pages.get(id)!;

    expect(await placePage(asBook, "moved", get("y"), "before")).toBe(true);
    expect(book.change).toHaveBeenLastCalledWith("moved", {
      parent: null,
      order: 25,
    });
    await placePage(asBook, "moved", get("x"), "before");
    expect(book.change).toHaveBeenLastCalledWith("moved", {
      parent: null,
      order: 31,
    });
    await placePage(asBook, "moved", get("z"), "after");
    expect(book.change).toHaveBeenLastCalledWith("moved", {
      parent: null,
      order: 9,
    });
  });

  it("appends inside a page after its last child for oldest-first sorting", async () => {
    const { book, asBook } = fakeBook(
      [
        page("parent", { order: 1 }),
        page("c1", { parent: "parent", order: 5 }),
        page("c2", { parent: "parent", order: 8 }),
        page("moved", { order: 2 }),
      ],
      "oldest",
    );

    await placePage(asBook, "moved", book.pages.get("parent")!, "inside");
    expect(book.change).toHaveBeenLastCalledWith("moved", {
      parent: "parent",
      order: 9,
    });
  });

  it("does not change anything for a refused placement", async () => {
    const { book, asBook } = tree();

    expect(await placePage(asBook, "a", book.pages.get("a1")!, "inside")).toBe(
      false,
    );
    expect(await placeAtEnd(asBook, "row")).toBe(false);
    expect(book.change).not.toHaveBeenCalled();
  });

  it("moves a page to the end of the top level", async () => {
    const { book, asBook } = fakeBook([
      page("x", { order: 30 }),
      page("y", { order: 20 }),
      page("moved", { parent: "x", order: 50 }),
    ]);

    expect(await placeAtEnd(asBook, "moved")).toBe(true);
    expect(book.change).toHaveBeenCalledWith("moved", {
      parent: null,
      order: 19,
    });
  });
});
