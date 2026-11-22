import { afterEach, describe, expect, it, vi } from "vitest";
import type { Notebook, Page } from "../../src/notebook/notebook";
import type { T } from "../../src/locale/locale";

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async () => undefined),
}));

const { erasePage, firstLetter, movePage, pick, restorePage } =
  await import("../../src/workspace/commands");

const t = ((key: string) =>
  key === "movedTo" ? "Moved to {place}" : key) as T;

function page(id: string, overrides: Partial<Page> = {}): Page {
  return {
    id,
    title: id,
    kind: "page",
    parent: null,
    order: 1,
    icon: "",
    favorite: false,
    archived: null,
    updated: 0,
    cover: "",
    wide: false,
    ...overrides,
  };
}

function fakeBook(pages: Page[]) {
  return {
    pages: new Map(pages.map((item) => [item.id, item])),
    change: vi.fn(async () => {}),
    trashBranch: vi.fn(async () => {}),
    branch: vi.fn((id: string) => [id]),
    erase: vi.fn(async () => {}),
  };
}

function asBook(book: ReturnType<typeof fakeBook>) {
  return book as unknown as Notebook;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("workspace helpers", () => {
  it("takes the first visible character of a name in upper case", () => {
    expect(firstLetter("  élan")).toBe("É");
    expect(firstLetter("🧭 Kompass")).toBe("🧭");
    expect(firstLetter("   ")).toBe("K");
  });

  it("picks within the list even at the edges of the random range", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(pick(["a", "b", "c"])).toBe("c");
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pick(["a", "b", "c"])).toBe("a");
  });
});

describe("restoring from the trash", () => {
  it("moves a page to the top level when its parent is still in the trash", async () => {
    const book = fakeBook([
      page("parent", { archived: 1 }),
      page("child", { parent: "parent", archived: 1 }),
    ]);

    await restorePage(asBook(book), "child");
    expect(book.change).toHaveBeenCalledWith("child", { parent: null });
    expect(book.trashBranch).toHaveBeenCalledWith("child", null);
  });

  it("keeps a database row inside its trashed database", async () => {
    const book = fakeBook([
      page("db", { kind: "database", archived: 1 }),
      page("row", { kind: "row", parent: "db", archived: 1 }),
    ]);

    await restorePage(asBook(book), "row");
    expect(book.change).not.toHaveBeenCalled();
    expect(book.trashBranch).toHaveBeenCalledWith("row", null);
  });

  it("does nothing for an unknown page", async () => {
    const book = fakeBook([]);

    await restorePage(asBook(book), "missing");
    expect(book.trashBranch).not.toHaveBeenCalled();
  });
});

describe("moving pages", () => {
  it("names the new place and undoes to the old parent and order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    const moved = page("moved", { parent: "old", order: 7 });
    const book = fakeBook([moved, page("target", { title: "" })]);
    const toast = (await movePage(asBook(book), t, moved, "target"))!;

    expect(book.change).toHaveBeenCalledWith("moved", {
      parent: "target",
      order: 5000,
    });
    expect(toast.text).toBe("Moved to untitled");
    toast.undo!();
    expect(book.change).toHaveBeenLastCalledWith("moved", {
      parent: "old",
      order: 7,
    });
  });

  it("names the top level when moved out of every parent", async () => {
    const moved = page("moved", { parent: "old" });
    const toast = (await movePage(asBook(fakeBook([moved])), t, moved, null))!;

    expect(toast.text).toBe("Moved to root");
  });
});

describe("erasing", () => {
  it("erases nothing when the question is declined", async () => {
    const book = fakeBook([page("a")]);
    const ask = vi.fn(async () => null);

    await erasePage(asBook(book), ask, t, page("a"));
    expect(ask).toHaveBeenCalledWith("eraseQuestion", undefined, {
      detail: "eraseDetail",
      action: "erase",
      danger: true,
    });
    expect(book.erase).not.toHaveBeenCalled();
  });
});
