import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "../../src/notebook/notebook";
import type { WorkspaceContext } from "../../src/workspace/pageActions";
import type { Toast } from "../../src/workspace/types";

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async () => undefined),
}));
vi.mock("../../src/workspace/TitleField", () => ({ selectTitle: vi.fn() }));

const { moveToTrash, openRow, setPageImage, switchBook } =
  await import("../../src/workspace/pageActions");

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

function context(pages: Page[], current: string | null = null) {
  const map = new Map(pages.map((item) => [item.id, item]));
  const book = {
    id: "book",
    pages: map,
    trashBranch: vi.fn(async (id: string, at: number | null) => {
      for (const item of map.values())
        if (item.id === id || item.parent === id) item.archived = at;
    }),
    change: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    load: vi.fn(async (id: string) => ({ id })),
  };
  const overlays = {
    setPopup: vi.fn(),
    setModal: vi.fn(),
    setRow: vi.fn(),
  };
  const value = {
    book,
    t: (key: string) => key,
    ask: vi.fn(),
    current,
    open: vi.fn(async () => {}),
    show: vi.fn(async () => true),
    changeBook: vi.fn(async () => {}),
    overlays,
    toast: vi.fn<(toast: Toast) => void>(),
  };

  return { ...value, context: value as unknown as WorkspaceContext };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("page actions", () => {
  it("leaves a page that was trashed together with its parent and offers undo", async () => {
    const parent = page("parent");
    const setup = context(
      [parent, page("child", { parent: "parent" })],
      "child",
    );

    await moveToTrash(setup.context, parent);
    expect(setup.open).toHaveBeenCalledWith(null);
    const [[toast]] = setup.toast.mock.calls;

    expect(toast!.text).toBe("trashed");
    toast!.undo!();
    await vi.waitFor(() =>
      expect(setup.book.trashBranch).toHaveBeenLastCalledWith("parent", null),
    );
  });

  it("stays on the current page when an unrelated page is trashed", async () => {
    const setup = context([page("a"), page("b")], "a");

    await moveToTrash(setup.context, page("b"));
    expect(setup.open).not.toHaveBeenCalled();
  });

  it("refuses page images that are not plain raster images", async () => {
    const setup = context([page("a")]);
    const hostile = [
      new File(["<svg onload=alert(1)>"], "x.svg", { type: "image/svg+xml" }),
      new File(["<p>"], "x.png", { type: "text/html" }),
      new File([""], "x.png", { type: "" }),
    ];

    for (const file of hostile)
      await setPageImage(setup.context, "cover", "a", file);
    await setPageImage(setup.context, "cover", "a");
    expect(setup.overlays.setPopup).not.toHaveBeenCalled();
    expect(setup.book.load).not.toHaveBeenCalled();
    expect(setup.book.change).not.toHaveBeenCalled();
  });

  it("does not flush or reload when switching to the open notebook", async () => {
    const setup = context([]);

    await switchBook(setup.context, "book");
    expect(setup.book.flush).not.toHaveBeenCalled();
    expect(setup.changeBook).not.toHaveBeenCalled();
    await switchBook(setup.context, "other");
    expect(setup.book.flush).toHaveBeenCalled();
    expect(setup.changeBook).toHaveBeenCalledWith("other");
  });

  it("opens a row only when it belongs to a database", async () => {
    const setup = context([
      page("loose", { kind: "row" }),
      page("row", { kind: "row", parent: "db" }),
    ]);

    await openRow(setup.context, "loose");
    await openRow(setup.context, "missing");
    expect(setup.overlays.setRow).not.toHaveBeenCalled();
    await openRow(setup.context, "row");
    expect(setup.overlays.setRow).toHaveBeenCalledWith({
      entry: { id: "row" },
      db: { id: "db" },
    });
  });
});
