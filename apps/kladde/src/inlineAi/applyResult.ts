import type { BlockNoteEditor } from "@blocknote/core";
import { isEmptyParagraph } from "../editor/fileBlocks";
import type { InlineStart } from "./actions";

type Blocks = ReturnType<BlockNoteEditor["tryParseMarkdownToBlocks"]>;

export function replaceSelection(
  editor: BlockNoteEditor,
  start: InlineStart,
  blocks: Blocks,
) {
  const first = blocks[0];

  if (
    blocks.length === 1 &&
    first.type === "paragraph" &&
    Array.isArray(first.content)
  )
    editor.insertInlineContent(first.content);
  else editor.replaceBlocks(start.blocks, blocks);
}

export function insertBelowSelection(
  editor: BlockNoteEditor,
  start: InlineStart,
  blocks: Blocks,
) {
  const anchor = editor.getBlock(start.blocks[start.blocks.length - 1]);

  if (!anchor) return false;

  if (!start.selection && isEmptyParagraph(anchor))
    editor.replaceBlocks([anchor], blocks);
  else editor.insertBlocks(blocks, anchor, "after");

  return true;
}
