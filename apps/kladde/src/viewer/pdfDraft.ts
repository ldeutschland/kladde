import type { Mark, Turn } from "./marks";
import type { PdfInfo } from "./pdfPages";
import type { T } from "../locale/locale";

export interface PageDraft {
  source: number;
  turn: Turn;
  marks: Mark[];
}

export const NO_PAGES: PageDraft[] = [];

export function originalPages(info: PdfInfo | null | undefined): PageDraft[] {
  return info
    ? info.sizes.map((_, source) => ({ source, turn: 0, marks: [] }))
    : NO_PAGES;
}

export function moveItem<V>(list: V[], from: number, to: number) {
  const next = [...list];
  const [item] = next.splice(from, 1);

  next.splice(to, 0, item);

  return next;
}

export function pageLabel(t: T, index: number) {
  return t("pageNumber").replace("{page}", String(index + 1));
}
