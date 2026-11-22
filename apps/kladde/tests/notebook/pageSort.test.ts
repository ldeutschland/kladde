import { describe, expect, it, vi } from "vitest";
import type { Page } from "../../src/notebook/notebook";

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string) =>
    name === "load_state" ? new ArrayBuffer(0) : undefined,
  ),
}));

const { Notebook } = await import("../../src/notebook/notebook");
const { closedPages, comparePages, pageSort, placementSort, saveClosedPages } =
  await import("../../src/notebook/pageSort");

type Book = Awaited<ReturnType<typeof Notebook.create>>;

function place(book: Book, title: string, order: number, updated = order) {
  const { id } = book.add(title);

  book.pages.set(id, { ...book.pages.get(id)!, order, updated });

  return book.pages.get(id)!;
}

function titles(
  book: Book,
  pages: Page[],
  sort: Parameters<typeof comparePages>[1],
) {
  return [...pages].sort(comparePages(book, sort)).map((page) => page.title);
}

describe("page sort setting", () => {
  it("falls back to newest for unknown or hostile stored values", async () => {
    const book = await Notebook.create("Notizbuch");

    for (const value of [
      "",
      "Title",
      "__proto__",
      3,
      null,
      ["title"],
      { sort: "title" },
    ]) {
      book.settings.set("pageSort", value);
      expect(pageSort(book)).toBe("newest");
    }

    book.settings.set("pageSort", "edited");
    expect(pageSort(book)).toBe("edited");
  });

  it("places new pages oldest-first only when the list is sorted oldest-first", async () => {
    const book = await Notebook.create("Notizbuch");
    const placements = ["newest", "oldest", "edited", "title", "bogus"].map(
      (sort) => {
        book.settings.set("pageSort", sort);

        return placementSort(book);
      },
    );

    expect(placements).toEqual([
      "newest",
      "oldest",
      "newest",
      "newest",
      "newest",
    ]);
  });
});

describe("comparing pages", () => {
  it("orders by creation in both directions", async () => {
    const book = await Notebook.create("Notizbuch");
    const pages = [
      place(book, "b", 2),
      place(book, "c", 3),
      place(book, "a", 1),
    ];

    expect(titles(book, pages, "newest")).toEqual(["c", "b", "a"]);
    expect(titles(book, pages, "oldest")).toEqual(["a", "b", "c"]);
  });

  it("orders by the latest edit, newest first", async () => {
    const book = await Notebook.create("Notizbuch");
    const pages = [
      place(book, "alt angelegt, neu bearbeitet", 1, 900),
      place(book, "neu angelegt, nie bearbeitet", 5, 5),
      place(book, "mittel", 3, 400),
    ];

    expect(titles(book, pages, "edited")).toEqual([
      "alt angelegt, neu bearbeitet",
      "mittel",
      "neu angelegt, nie bearbeitet",
    ]);
  });

  it("sorts titles naturally and ignores case and accents", async () => {
    const book = await Notebook.create("Notizbuch");
    const pages = ["Seite 10", "seite 2", "Seite 1", "Zebra", "Äpfel"].map(
      (title, i) => place(book, title, i),
    );

    expect(titles(book, pages, "title")).toEqual([
      "Äpfel",
      "Seite 1",
      "seite 2",
      "Seite 10",
      "Zebra",
    ]);
  });

  it("breaks title ties by recency and then by id so the order is stable", async () => {
    const book = await Notebook.create("Notizbuch");
    const older = place(book, "Notiz", 1);
    const newer = place(book, "NOTIZ", 2);
    const twins = [place(book, "gleich", 7), place(book, "gleich", 7)];
    const byId = [...twins]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => p.id);

    expect([older, newer].sort(comparePages(book, "title"))).toEqual([
      newer,
      older,
    ]);

    for (const sort of ["newest", "oldest", "edited", "title"] as const) {
      const forward = [...twins]
        .sort(comparePages(book, sort))
        .map((p) => p.id);
      const backward = [...twins]
        .reverse()
        .sort(comparePages(book, sort))
        .map((p) => p.id);

      expect(forward).toEqual(byId);
      expect(backward).toEqual(byId);
    }
  });
});

describe("closed tree branches", () => {
  it("reads only string ids and tolerates a corrupted setting", async () => {
    const book = await Notebook.create("Notizbuch");

    book.settings.set("treeClosed", "not-a-list");
    expect(closedPages(book).size).toBe(0);
    book.settings.set("treeClosed", ["a", 1, null, { id: "b" }, "c"]);
    expect([...closedPages(book)]).toEqual(["a", "c"]);
  });

  it("saves only pages that still exist", async () => {
    const book = await Notebook.create("Notizbuch");
    const page = place(book, "offen", 1);

    saveClosedPages(book, new Set([page.id, "gelöscht", "__proto__"]));
    expect(book.settings.get("treeClosed")).toEqual([page.id]);
    expect([...closedPages(book)]).toEqual([page.id]);
  });
});
