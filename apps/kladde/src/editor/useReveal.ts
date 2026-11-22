import { useEffect, type RefObject } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import type { Entry } from "../notebook/notebook";
import type { ViewTarget } from "../viewer/viewing";
import { viewTargetOf } from "./FileBlock";
import {
  blockElement,
  findFileBlock,
  findTextBlock,
  showFound,
  type Reveal,
} from "../search/reveal";

const REVEAL_STEP_MS = 50;
const REVEAL_TRIES = 40;

interface RevealOptions {
  editor: BlockNoteEditor;
  section: RefObject<HTMLElement | null>;
  entry: Entry;
  view: (target: ViewTarget) => void;
  reveal?: Reveal;
  revealed?: () => void;
}

function revealedElement(
  editor: BlockNoteEditor,
  root: HTMLElement,
  reveal: Reveal,
) {
  if (!reveal.file) return { element: findTextBlock(root, reveal.terms) };
  const block = findFileBlock(editor.document, reveal.file);

  return { block, element: block && blockElement(root, block.id) };
}

export function useReveal(options: RevealOptions) {
  const { editor, section, entry, view, reveal, revealed } = options;

  useEffect(() => {
    if (!reveal) return;
    let tries = 0;
    const timer = setInterval(() => {
      const root = section.current;
      const { block, element } = root
        ? revealedElement(editor, root, reveal)
        : { block: undefined, element: undefined };

      tries += 1;
      if (!element && tries < REVEAL_TRIES) return;
      clearInterval(timer);
      revealed?.();
      if (!element) return;
      showFound(element, reveal.file ? [] : reveal.terms);
      const target = block && viewTargetOf(entry, block);

      if (target) view({ ...target, page: reveal.index, found: reveal.found });
    }, REVEAL_STEP_MS);

    return () => clearInterval(timer);
  }, [editor, section, entry, view, reveal, revealed]);
}
