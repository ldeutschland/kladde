import { useEffect, useState, type DragEvent } from "react";
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
  guardWindowDrops,
  movable,
} from "../ui/dragDrop";
import { IMAGE_TYPES } from "./commands";
import type { DropZone, ImageKey } from "./types";

type Accepts = (e: DragEvent) => boolean;
type Effect = "copy" | "move" | "link";
type Handle = (e: DragEvent<HTMLElement>) => void;

export interface DropActions {
  setImage: (key: ImageKey, target: string, file: File) => void;
  notify: (text: string) => void;
  trash: (page: Page) => void;
  openTab: (target: string) => void;
  move: (page: Page, parent: string | null) => void;
  importInto: (files: File[], parent: string | null) => void;
}

function useDropTarget() {
  const [zone, setZone] = useState<DropZone | null>(null);

  useEffect(() => guardWindowDrops(), []);

  return (
    name: DropZone,
    accepts: Accepts,
    effect: Effect,
    handle: Handle,
  ) => ({
    "data-drop": zone === name || undefined,
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!accepts(e)) return;
      allowDrop(e, effect);
      e.stopPropagation();
      if (zone !== name) setZone(name);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null))
        setZone(null);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      setZone(null);
      if (!accepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      handle(e);
    },
  });
}

function leavesParent(book: Notebook) {
  return (e: DragEvent) => {
    const dragged = draggedPage();

    if (!carriesPage(e) || !dragged || !movable(book, dragged)) return false;

    return !!book.pages.get(dragged)?.parent;
  };
}

function acceptsInto(book: Notebook, target: Page) {
  return (e: DragEvent) => {
    const dragged = draggedPage();

    if (!carriesPage(e) || !dragged || dragged === target.id) return false;
    if (book.pages.get(dragged)?.parent === target.id) return false;

    return canPlace(book, dragged, target, "inside");
  };
}

export function usePageDrops(book: Notebook, t: T, actions: DropActions) {
  const dropTarget = useDropTarget();
  const withPage = (use: (page: Page) => void) => (e: DragEvent) => {
    const dropped = droppedPage(e, book);

    if (dropped) use(dropped);
  };

  return {
    image: (key: ImageKey, target: string) =>
      dropTarget(key, carriesFiles, "copy", (e) => {
        const file = droppedFiles(e)[0];

        if (file && IMAGE_TYPES.includes(file.type))
          actions.setImage(key, target, file);
        else actions.notify(t("imagesOnly"));
      }),
    trash: dropTarget("trash", carriesPage, "move", withPage(actions.trash)),
    tabs: dropTarget(
      "tabs",
      carriesPage,
      "link",
      withPage((page) => actions.openTab(page.id)),
    ),
    favorites: dropTarget(
      "favorites",
      carriesPage,
      "link",
      withPage((page) => {
        if (!page.favorite) void book.change(page.id, { favorite: true });
      }),
    ),
    root: dropTarget(
      "root",
      leavesParent(book),
      "move",
      withPage((page) => {
        if (movable(book, page.id)) actions.move(page, null);
      }),
    ),
    home: dropTarget("home", carriesFiles, "copy", (e) =>
      actions.importInto(droppedFiles(e), null),
    ),
    crumb: (target: Page) =>
      dropTarget(
        `crumb:${target.id}`,
        acceptsInto(book, target),
        "move",
        withPage((page) => actions.move(page, target.id)),
      ),
  };
}

export type PageDrops = ReturnType<typeof usePageDrops>;
