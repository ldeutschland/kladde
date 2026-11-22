import { useEffect, useRef, useState, type DragEvent } from "react";
import { command } from "../platform/native";
import type { Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import {
  allowDrop,
  canPlace,
  carriesFiles,
  carriesPage,
  draggedPage,
  droppedFiles,
  droppedPage,
  placeAt,
  placeAtEnd,
  placePage,
  scrollWhileDragging,
  type Place,
} from "../ui/dragDrop";
import { expandPage, type TreeChildren } from "./treeRows";

export interface DropHint {
  id: string;
  place: Place;
}

interface TreeDropOptions {
  book: Notebook;
  children: TreeChildren;
  closed: Set<string>;
  t: T;
  notify: (text: string) => void;
  importInto: (files: File[], parent: string | null) => void;
}

const OPEN_DELAY_MS = 600;
const MOVED_FLASH_MS = 1200;

function carriesDrop(event: DragEvent) {
  return carriesFiles(event) || carriesPage(event);
}

function scrollTree(event: DragEvent<HTMLElement>) {
  scrollWhileDragging(event, event.currentTarget.closest(".treewrap"));
}

function dropFolder(target: Page | null) {
  return (target?.kind === "page" ? target.id : target?.parent) ?? null;
}

function placeInTree(
  book: Notebook,
  id: string,
  target: Page | null,
  place: Place,
) {
  return target ? placePage(book, id, target, place) : placeAtEnd(book, id);
}

function pageHint(
  event: DragEvent<HTMLElement>,
  page: Page,
  { book, children, closed }: TreeDropOptions,
): DropHint | null {
  const place = placeAt(event, event.currentTarget, page.kind === "page");
  const first = children.get(page.id)?.[0];
  const opened = first && !closed.has(page.id);
  const hinted: DropHint =
    place === "after" && opened
      ? { id: first.id, place: "before" }
      : { id: page.id, place };
  const target = book.pages.get(hinted.id);
  const dragged = draggedPage();

  if (!target || (dragged && !canPlace(book, dragged, target, hinted.place)))
    return null;

  return hinted;
}

function usePageMove({ book, t, notify }: TreeDropOptions) {
  const [moved, setMoved] = useState<string | null>(null);

  useEffect(() => {
    if (!moved) return;
    document
      .querySelector(`.treerow[data-id="${CSS.escape(moved)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const timer = setTimeout(() => setMoved(null), MOVED_FLASH_MS);

    return () => clearTimeout(timer);
  }, [moved]);

  async function movePage(id: string, target: Page | null, place: Place) {
    if (id === target?.id) return;

    if (!(await placeInTree(book, id, target, place))) {
      notify(t("cannotMove"));

      return;
    }

    void command("haptic");
    if (target && place === "inside") expandPage(book, target.id);
    setMoved(id);
  }

  return { moved, movePage };
}

function useDelayedOpen(book: Notebook, closed: Set<string>) {
  const opener = useRef<{ id: string; timer: number } | null>(null);

  useEffect(() => () => clearTimeout(opener.current?.timer), []);

  function stopOpening() {
    clearTimeout(opener.current?.timer);
    opener.current = null;
  }

  function openLater(id: string) {
    if (!closed.has(id) || opener.current?.id === id) return;
    stopOpening();
    const timer = window.setTimeout(() => expandPage(book, id), OPEN_DELAY_MS);

    opener.current = { id, timer };
  }

  return { opener, stopOpening, openLater };
}

function useDropHint(delayedOpen: ReturnType<typeof useDelayedOpen>) {
  const [hint, setHint] = useState<DropHint | null>(null);

  function showHint(next: DropHint | null) {
    if (next?.id !== hint?.id || next?.place !== hint?.place) setHint(next);
    if (next?.place !== "inside" || next.id !== delayedOpen.opener.current?.id)
      delayedOpen.stopOpening();
  }

  return { hint, showHint };
}

export function useTreeDrop(options: TreeDropOptions) {
  const { book, children, importInto } = options;
  const { moved, movePage } = usePageMove(options);
  const delayedOpen = useDelayedOpen(book, options.closed);
  const { hint, showHint } = useDropHint(delayedOpen);

  function dragOverRow(event: DragEvent<HTMLElement>, page: Page) {
    if (!carriesDrop(event)) return;
    event.stopPropagation();
    scrollTree(event);
    const next = carriesFiles(event)
      ? { id: page.id, place: "inside" as const }
      : pageHint(event, page, options);

    if (!next) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "none";
      showHint(null);

      return;
    }

    allowDrop(event, carriesFiles(event) ? "copy" : "move");
    showHint(next);
    if (next.place === "inside" && children.has(page.id))
      delayedOpen.openLater(page.id);
  }

  function dropPage(
    event: DragEvent<HTMLElement>,
    target: Page | null,
    planned: DropHint | null,
  ) {
    const dropped = droppedPage(event, book);

    if (!dropped) return;

    if (!target) {
      void movePage(dropped.id, null, "after");

      return;
    }

    if (!planned) return;
    void movePage(
      dropped.id,
      book.pages.get(planned.id) ?? null,
      planned.place,
    );
  }

  function drop(event: DragEvent<HTMLElement>, target: Page | null) {
    if (!carriesDrop(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const planned = target ? pageHint(event, target, options) : null;

    showHint(null);

    if (carriesFiles(event)) {
      importInto(droppedFiles(event), dropFolder(target));

      return;
    }

    dropPage(event, target, planned);
  }

  function dragOverTree(event: DragEvent<HTMLElement>) {
    if (!carriesDrop(event)) return;
    scrollTree(event);
    allowDrop(event, carriesFiles(event) ? "copy" : "move");
    showHint({ id: "", place: "after" });
  }

  function leaveTree(event: DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
      showHint(null);
  }

  return { hint, moved, showHint, dragOverRow, drop, dragOverTree, leaveTree };
}
