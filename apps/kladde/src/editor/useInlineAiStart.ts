import { useState, type RefObject } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import type { T, Word } from "../locale/locale";
import type { InlineStart } from "../inlineAi/actions";
import { findBlock } from "./selectionDom";

const MENU_GAP = 4;

interface InlineOptions {
  editor: BlockNoteEditor;
  section: RefObject<HTMLElement | null>;
  excluded: boolean;
  t: T;
  notify: (text: string) => void;
}

function chosenBlocks(editor: BlockNoteEditor) {
  const selected = editor.getSelection()?.blocks;

  return selected?.length ? selected : [editor.getTextCursorPosition().block];
}

function menuTop(section: HTMLElement | null, blockId: string) {
  const element = section && findBlock(section, blockId);
  const frame = section?.getBoundingClientRect();
  const rect = element?.getBoundingClientRect();

  return frame && rect ? rect.bottom - frame.top + MENU_GAP : 0;
}

export function useInlineAiStart(options: InlineOptions) {
  const { editor, section } = options;
  const [inline, setInline] = useState<InlineStart | null>(null),
    [opening, setOpening] = useState(0);

  function start(action?: Word) {
    if (options.excluded) {
      options.notify(options.t("aiExcludedPage"));

      return;
    }

    const blocks = chosenBlocks(editor);
    const last = blocks[blocks.length - 1];

    setOpening(opening + 1);
    setInline({
      top: menuTop(section.current, last.id),
      selection: editor.getSelectedText(),
      blocks: blocks.map((block) => block.id),
      action,
    });
  }

  function close() {
    setInline(null);
    editor.focus();
  }

  return { inline, opening, start, close, dismiss: () => setInline(null) };
}

export type InlineAiStart = ReturnType<typeof useInlineAiStart>;
