import type { DragEvent } from "react";
import { mayMove, type Notebook, type Page } from "../notebook/notebook";
import { comparePages, placementSort } from "../notebook/pageSort";

const PAGE_TYPE = "text/kladde";
const TAB_TYPE = "text/kladde-tab";
const FILE_TYPE = "Files";
const EDGE_SHARE = 0.25;
const SCROLL_ZONE = 40;
const SCROLL_STEP = 12;
const SOURCE_MARK = "data-drag-source";

let draggedPageId: string | null = null;

export type Place = "before" | "inside" | "after";
type AnyDragEvent = DragEvent | globalThis.DragEvent;

function types(e: AnyDragEvent) {
  return Array.from(e.dataTransfer?.types ?? []);
}

export function carriesPage(e: AnyDragEvent) {
  return types(e).includes(PAGE_TYPE);
}

export function carriesFiles(e: AnyDragEvent) {
  return types(e).includes(FILE_TYPE);
}

function showDragChip(e: DragEvent, page: Page, label: string) {
  const chip = document.createElement("div");

  chip.className = "dragchip";
  const emoji = page.icon.startsWith("kladde-file:") ? "" : page.icon;

  chip.textContent = (emoji ? emoji + "  " : "") + label;
  document.body.append(chip);
  e.dataTransfer.setDragImage(chip, 14, 16);
  requestAnimationFrame(() => chip.remove());
}

function markSource(source: Element) {
  setTimeout(() => {
    if (draggedPageId) source.setAttribute(SOURCE_MARK, "");
    document.documentElement.dataset.dragging = "page";
  });
}

function endPageDrag() {
  draggedPageId = null;
  delete document.documentElement.dataset.dragging;
  for (const element of document.querySelectorAll(`[${SOURCE_MARK}]`))
    element.removeAttribute(SOURCE_MARK);
}

export function startPageDrag(e: DragEvent, page: Page, label: string) {
  endPageDrag();
  draggedPageId = page.id;
  e.dataTransfer.setData(PAGE_TYPE, page.id);
  e.dataTransfer.effectAllowed = "copyMove";
  showDragChip(e, page, label);
  markSource(e.currentTarget);
}

export function draggedPage() {
  return draggedPageId;
}

export function scrollWhileDragging(e: DragEvent, container: Element | null) {
  if (!container) return;
  const rect = container.getBoundingClientRect();

  if (e.clientY < rect.top + SCROLL_ZONE) container.scrollTop -= SCROLL_STEP;
  if (e.clientY > rect.bottom - SCROLL_ZONE) container.scrollTop += SCROLL_STEP;
}

export function carriesTab(e: AnyDragEvent) {
  return types(e).includes(TAB_TYPE);
}

export function startTabDrag(e: DragEvent, key: string) {
  e.dataTransfer.setData(TAB_TYPE, key);
  e.dataTransfer.effectAllowed = "move";
}

export function droppedTab(e: DragEvent) {
  return e.dataTransfer.getData(TAB_TYPE);
}

export function droppedPage(e: DragEvent, book: Notebook) {
  const page = book.pages.get(e.dataTransfer.getData(PAGE_TYPE));

  if (!page || page.archived || page.kind === "chat") return null;

  return page;
}

export function droppedFiles(e: DragEvent) {
  return Array.from(e.dataTransfer.files);
}

export function allowDrop(e: DragEvent, effect: "copy" | "move" | "link") {
  e.preventDefault();
  e.dataTransfer.dropEffect = effect;
}

export function placeAt(e: DragEvent, element: Element, inside: boolean) {
  const rect = element.getBoundingClientRect();
  const share = (e.clientY - rect.top) / Math.max(rect.height, 1);

  if (!inside) return share < 0.5 ? "before" : "after";
  if (share < EDGE_SHARE) return "before";
  if (share > 1 - EDGE_SHARE) return "after";

  return "inside";
}

function siblings(book: Notebook, parent: string | null, skip: string) {
  return Array.from(book.pages.values())
    .filter(
      (p) =>
        p.parent === parent &&
        p.id !== skip &&
        !p.archived &&
        p.kind !== "chat" &&
        p.kind !== "row",
    )
    .sort(comparePages(book, placementSort(book)));
}

function orderBetween(book: Notebook, previous?: Page, next?: Page) {
  const step = placementSort(book) === "newest" ? -1 : 1;

  if (previous && next) return (previous.order + next.order) / 2;
  if (previous) return previous.order + step;
  if (next) return next.order - step;

  return Date.now();
}

function targetOrder(book: Notebook, id: string, target: Page, place: Place) {
  if (place === "inside")
    return orderBetween(book, siblings(book, target.id, id).at(-1));
  const list = siblings(book, target.parent, id);
  const index = list.findIndex((p) => p.id === target.id);

  if (place === "before") return orderBetween(book, list[index - 1], target);

  return orderBetween(book, target, list[index + 1]);
}

export function movable(book: Notebook, id: string) {
  const page = book.pages.get(id);

  return !!page && page.kind !== "row" && page.kind !== "chat";
}

export function canPlace(
  book: Notebook,
  id: string,
  target: Page,
  place: Place,
) {
  if (id === target.id || !movable(book, id)) return false;
  if (place === "inside" && target.kind !== "page") return false;
  const parent = place === "inside" ? target.id : target.parent;

  return mayMove(book.pages, id, parent);
}

export async function placePage(
  book: Notebook,
  id: string,
  target: Page,
  place: Place,
) {
  if (!canPlace(book, id, target, place)) return false;
  const parent = place === "inside" ? target.id : target.parent;
  const order = targetOrder(book, id, target, place);

  await book.change(id, { parent, order });

  return true;
}

export async function placeAtEnd(book: Notebook, id: string) {
  if (!movable(book, id) || !mayMove(book.pages, id, null)) return false;
  await book.change(id, {
    parent: null,
    order: orderBetween(book, siblings(book, null, id).at(-1)),
  });

  return true;
}

function intoTextField(e: globalThis.DragEvent) {
  const target = e.target instanceof Element ? e.target : null;

  return !!target?.closest("input, textarea, [contenteditable='true']");
}

function refuseUnhandled(e: globalThis.DragEvent) {
  if (e.defaultPrevented || !e.dataTransfer) return;
  if (intoTextField(e) && !carriesFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "none";
}

function swallowDrop(e: globalThis.DragEvent) {
  if (!intoTextField(e) || carriesFiles(e)) e.preventDefault();
}

function endSoon() {
  setTimeout(endPageDrag);
}

export function guardWindowDrops() {
  window.addEventListener("dragover", refuseUnhandled);
  window.addEventListener("drop", swallowDrop);
  window.addEventListener("drop", endSoon, true);
  window.addEventListener("dragend", endSoon, true);

  return () => {
    window.removeEventListener("dragover", refuseUnhandled);
    window.removeEventListener("drop", swallowDrop);
    window.removeEventListener("drop", endSoon, true);
    window.removeEventListener("dragend", endSoon, true);
    endPageDrag();
  };
}
