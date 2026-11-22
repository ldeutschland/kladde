import type { BlockNoteEditor } from "@blocknote/core";
import { fileBlockType } from "../files/attachments";

export function isEmptyParagraph(block: { type: string; content?: unknown }) {
  return (
    block.type === "paragraph" &&
    Array.isArray(block.content) &&
    block.content.length === 0
  );
}

type Anchor = BlockNoteEditor["document"][number];

async function placeFile(editor: BlockNoteEditor, file: File, anchor: Anchor) {
  const block = { type: fileBlockType(file), props: { name: file.name } };
  const id = isEmptyParagraph(anchor)
    ? editor.updateBlock(anchor, block).id
    : editor.insertBlocks([block], anchor, "after")[0].id;
  const url = await editor.uploadFile?.(file, id).catch(() => undefined);

  if (typeof url === "string" && editor.getBlock(id))
    editor.updateBlock(id, { props: { url } });
}

export async function appendFiles(editor: BlockNoteEditor, files: File[]) {
  for (const file of files) {
    const last = editor.document.at(-1);

    if (!last) return;
    await placeFile(editor, file, last);
  }
}

export function insertFileAtCursor(editor: BlockNoteEditor, file: File) {
  return placeFile(editor, file, editor.getTextCursorPosition().block);
}
