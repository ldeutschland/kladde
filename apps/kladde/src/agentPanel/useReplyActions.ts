import { useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import type { Notebook } from "../notebook/notebook";
import { writeMarkdown } from "../notebook/content";
import { styleCallouts } from "../notebook/pageMarkdown";
import { isEmptyParagraph } from "../editor/fileBlocks";

const TITLE_LENGTH = 200;
const FIRST_HEADING = /^#{1,3}\s+(.+)$/m;

function insertMarkdown(target: BlockNoteEditor, text: string) {
  const blocks = styleCallouts(target.tryParseMarkdownToBlocks(text));
  const block = target.getTextCursorPosition().block;

  if (isEmptyParagraph(block)) target.replaceBlocks([block], blocks);
  else target.insertBlocks(blocks, block, "after");
}

export function useReplyActions(
  book: Notebook,
  editor: () => BlockNoteEditor | null,
  open: (id: string) => void,
) {
  const [copied, setCopied] = useState(-1);

  async function copy(text: string, index: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
    } catch {
      setCopied(-1);
    }
  }

  function insert(text: string) {
    const target = editor();

    if (target) insertMarkdown(target, text);
  }

  async function saveAsPage(text: string, question: string) {
    const heading = FIRST_HEADING.exec(text);
    const title = (heading ? heading[1] : question).slice(0, TITLE_LENGTH);
    const entry = book.add(title, "page");

    writeMarkdown(entry, text, styleCallouts);
    await book.flush();
    open(entry.id);
  }

  return { copied, copy, insert, saveAsPage };
}

export type ReplyActions = ReturnType<typeof useReplyActions>;
