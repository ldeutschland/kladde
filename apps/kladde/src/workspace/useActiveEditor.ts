import { useCallback, useRef } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { isEmptyParagraph } from "../editor/fileBlocks";
import type { NoteBlock } from "../capture/Recorder";

function startsWithEmptyParagraph(editor: BlockNoteEditor) {
  const first = editor.document[0];

  return (
    first?.type === "paragraph" &&
    Array.isArray(first.content) &&
    first.content.length === 0
  );
}

export function useActiveEditor() {
  const editor = useRef<BlockNoteEditor | null>(null),
    recordAt = useRef<string | null>(null);
  const register = useCallback((e: BlockNoteEditor | null) => {
    editor.current = e;
  }, []);

  function markRecordingSpot() {
    const current = editor.current;

    if (!current) return false;
    const target = current.isFocused()
      ? current.getTextCursorPosition().block
      : current.document.at(-1);

    recordAt.current = target?.id ?? null;

    return true;
  }

  function insertNote(blocks: NoteBlock[]) {
    const current = editor.current;
    const target = recordAt.current
      ? current?.getBlock(recordAt.current)
      : current?.document.at(-1);

    if (!current || !target) return;
    if (isEmptyParagraph(target)) current.replaceBlocks([target.id], blocks);
    else current.insertBlocks(blocks, target.id, "after");
  }

  function leaveTitle(split: boolean) {
    const current = editor.current;

    if (!current) return;
    const first = current.document[0];

    if (split && first && !startsWithEmptyParagraph(current))
      current.insertBlocks([{ type: "paragraph" }], first, "before");
    const target = current.document[0];

    if (target) current.setTextCursorPosition(target, "start");
    current.focus();
  }

  return { editor, register, markRecordingSpot, insertNote, leaveTitle };
}

export type ActiveEditor = ReturnType<typeof useActiveEditor>;
