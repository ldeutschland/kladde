import type { KeyboardEvent } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { isEmptyParagraph } from "./fileBlocks";

const OPEN_MENU = ".bn-suggestion-menu, [role='dialog'], [role='menu']";

export interface EditorKeyContext {
  editor: BlockNoteEditor;
  mobile: boolean;
  inlineOpen: boolean;
  aiReady: boolean;
  pickBlocks: (ids: string[]) => void;
  startInline?: () => void;
}

function menuOpen() {
  return !!document.querySelector(OPEN_MENU);
}

function cursorBlockIds(editor: BlockNoteEditor) {
  const chosen = editor.getSelection()?.blocks ?? [
    editor.getTextCursorPosition().block,
  ];

  return chosen.map((block) => block.id);
}

function onEmptyLine(editor: BlockNoteEditor) {
  if (editor.getSelectedText()) return false;

  return isEmptyParagraph(editor.getTextCursorPosition().block);
}

function plainKey(event: KeyboardEvent) {
  return !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

function aiShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === "j" &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey
  );
}

function aiSpace(event: KeyboardEvent, context: EditorKeyContext) {
  return (
    event.key === " " &&
    context.aiReady &&
    plainKey(event) &&
    onEmptyLine(context.editor)
  );
}

function selectsBlocks(event: KeyboardEvent, context: EditorKeyContext) {
  return (
    event.key === "Escape" &&
    !context.inlineOpen &&
    !context.mobile &&
    !menuOpen()
  );
}

export function handleEditorKey(
  event: KeyboardEvent<HTMLElement>,
  context: EditorKeyContext,
) {
  if (!(event.target as Element).closest(".bn-editor")) return;
  if (event.nativeEvent.isComposing) return;

  if (selectsBlocks(event, context)) {
    event.preventDefault();
    event.stopPropagation();
    context.pickBlocks(cursorBlockIds(context.editor));

    return;
  }

  const { startInline } = context;

  if (!startInline) return;
  if (!aiShortcut(event) && !aiSpace(event, context)) return;
  event.preventDefault();
  event.stopPropagation();
  startInline();
}
