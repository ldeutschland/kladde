import { treeParent, type Notebook, type Page } from "../notebook/notebook";
import {
  closedPages,
  comparePages,
  saveClosedPages,
  type PageSort,
} from "../notebook/pageSort";

export type TreeChildren = Map<string | null, Page[]>;

export interface TreeRowItem {
  page: Page;
  depth: number;
}

interface VisibleRowsOptions {
  root: string | null;
  hidden: string | null;
  closed: Set<string>;
  limit: number;
}

function listedInTree(page: Page) {
  return !page.archived && page.kind !== "chat" && page.kind !== "row";
}

export function treeChildren(book: Notebook, sort: PageSort): TreeChildren {
  const byParent: TreeChildren = new Map();

  for (const page of book.pages.values()) {
    if (!listedInTree(page)) continue;
    const parent = treeParent(book.pages, page);
    const list = byParent.get(parent) ?? [];

    list.push(page);
    byParent.set(parent, list);
  }

  for (const list of byParent.values()) list.sort(comparePages(book, sort));

  return byParent;
}

export function visibleRows(
  children: TreeChildren,
  { root, hidden, closed, limit }: VisibleRowsOptions,
) {
  const rows: TreeRowItem[] = [];
  const pending = (children.get(root) ?? [])
    .filter((page) => page.id !== hidden)
    .map((page) => ({ page, depth: 0 }))
    .reverse();
  const seen = new Set<string>();

  while (pending.length && rows.length < limit) {
    const row = pending.pop()!;

    if (seen.has(row.page.id)) continue;
    seen.add(row.page.id);
    rows.push(row);
    if (closed.has(row.page.id)) continue;
    for (const child of [...(children.get(row.page.id) ?? [])].reverse())
      pending.push({ page: child, depth: row.depth + 1 });
  }

  return { rows, more: pending.length > 0 };
}

export function expandPage(book: Notebook, id: string) {
  const closed = closedPages(book);

  if (!closed.delete(id)) return;
  saveClosedPages(book, closed);
}

export function togglePage(book: Notebook, id: string) {
  const closed = closedPages(book);

  if (!closed.delete(id)) closed.add(id);
  saveClosedPages(book, closed);
}
