import { useState, type DragEvent, type RefObject } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import type { Entry, Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import {
  allowDrop,
  carriesFiles,
  carriesPage,
  droppedFiles,
  droppedPage,
} from "../ui/dragDrop";
import { appendFiles } from "./fileBlocks";
import { pageLinkContent } from "./pageLinks";
import { BLOCK_SELECTOR, findBlock } from "./selectionDom";

export interface DropSpot {
  id: string;
  place: "before" | "after";
  line: number;
}

interface DropOptions {
  editor: BlockNoteEditor;
  book: Notebook;
  entry: Entry;
  t: T;
  section: RefObject<HTMLElement | null>;
}

function overEditor(event: DragEvent<HTMLElement>) {
  return !!(event.target as Element).closest(".bn-editor");
}

function spotAt(
  options: DropOptions,
  event: DragEvent<HTMLElement>,
): DropSpot | null {
  const root = options.section.current;
  const frame = root?.getBoundingClientRect();
  const hovered = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest(BLOCK_SELECTOR);
  const last = options.editor.document.at(-1);
  const element = hovered ?? (root && last ? findBlock(root, last.id) : null);
  const id = element?.getAttribute("data-id");

  if (!frame || !element || !id) return null;
  const rect = element.getBoundingClientRect();
  const before = !!hovered && event.clientY < rect.top + rect.height / 2;
  const edge = before ? rect.top : rect.bottom;

  return { id, place: before ? "before" : "after", line: edge - frame.top };
}

function insertPageBlock(
  options: DropOptions,
  page: Page,
  spot: DropSpot | null,
) {
  const { editor, book, t } = options;
  const reference = spot?.id ?? editor.document.at(-1)?.id;

  if (!reference) return;
  const [inserted] = editor.insertBlocks(
    [{ type: "paragraph", content: [pageLinkContent(book, t, page.id)] }],
    reference,
    spot?.place ?? "after",
  );

  editor.setTextCursorPosition(inserted, "end");
}

export function useEditorDrop(options: DropOptions) {
  const [dropSpot, setDropSpot] = useState<DropSpot | null>(null);

  function dragOver(event: DragEvent<HTMLElement>) {
    const page = carriesPage(event);

    if (!page && (!carriesFiles(event) || overEditor(event))) {
      if (dropSpot) setDropSpot(null);

      return;
    }

    allowDrop(event, page ? "link" : "copy");
    const spot = spotAt(options, event);

    if (spot?.id !== dropSpot?.id || spot?.line !== dropSpot?.line)
      setDropSpot(spot);
  }

  function dragLeave(event: DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
      setDropSpot(null);
  }

  function dropPage(event: DragEvent<HTMLElement>) {
    if (!carriesPage(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const spot = spotAt(options, event);

    setDropSpot(null);
    const page = droppedPage(event, options.book);

    if (page && page.id !== options.entry.id)
      insertPageBlock(options, page, spot);
  }

  function dropFiles(event: DragEvent<HTMLElement>) {
    setDropSpot(null);
    const skip =
      !carriesFiles(event) ||
      event.nativeEvent.defaultPrevented ||
      overEditor(event);

    if (skip) return;
    event.preventDefault();
    void appendFiles(options.editor, droppedFiles(event));
  }

  return { dropSpot, dragOver, dragLeave, dropPage, dropFiles };
}
