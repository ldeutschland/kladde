import type { Notebook, Page } from "./notebook";

export const PAGE_SORTS = ["newest", "oldest", "edited", "title"] as const;
export type PageSort = (typeof PAGE_SORTS)[number];

export function pageSort(book: Notebook): PageSort {
  const value = book.settings.get("pageSort");

  return PAGE_SORTS.find((sort) => sort === value) ?? "newest";
}

export function comparePages(book: Notebook, sort: PageSort) {
  return (a: Page, b: Page) => {
    const byId = a.id.localeCompare(b.id);

    if (sort === "oldest") return a.order - b.order || byId;
    if (sort === "edited") return book.editedAt(b) - book.editedAt(a) || byId;
    if (sort === "title")
      return (
        a.title.localeCompare(b.title, undefined, {
          numeric: true,
          sensitivity: "base",
        }) ||
        b.order - a.order ||
        byId
      );

    return b.order - a.order || byId;
  };
}

export function placementSort(book: Notebook): "newest" | "oldest" {
  return pageSort(book) === "oldest" ? "oldest" : "newest";
}

export function closedPages(book: Notebook) {
  const value = book.settings.get("treeClosed");

  if (!Array.isArray(value)) return new Set<string>();

  return new Set(value.filter((id): id is string => typeof id === "string"));
}

export function saveClosedPages(book: Notebook, closed: Set<string>) {
  const ids = Array.from(closed).filter((id) => book.pages.has(id));

  book.settings.set("treeClosed", ids);
}
