import { BlockNoteEditor, BlockNoteSchema } from "@blocknote/core";
import type * as Y from "yjs";
import {
  blocksToYXmlFragment,
  yXmlFragmentToBlocks,
} from "@blocknote/core/yjs";
import type { Entry, Notebook } from "./notebook";
import type { T } from "../locale/locale";
import { isValidLink } from "./links";
import { pageLinkSpec, setPageLinkContext } from "../editor/pageLinkSpec";

const documentSchema = BlockNoteSchema.create().extend({
  inlineContentSpecs: { pageLink: pageLinkSpec },
});

let converter: BlockNoteEditor | undefined;

export function blockEditor() {
  converter ??= BlockNoteEditor.create({
    schema: documentSchema,
    links: { isValidLink },
  }) as unknown as BlockNoteEditor;

  return converter;
}

export function namePageLinksFrom(book: Notebook, t: T) {
  setPageLinkContext(blockEditor(), { book, t });
}
export function blocks(e: Entry) {
  return yXmlFragmentToBlocks(blockEditor(), e.doc.getXmlFragment("blocks"));
}
export function markdown(e: Entry) {
  return blockEditor().blocksToMarkdownLossy(blocks(e));
}

const RESTORED_MAPS = ["properties", "schema", "views", "automations", "meta"];

function sameValue(current: unknown, saved: unknown) {
  return JSON.stringify(current) === JSON.stringify(saved);
}

function restoreMap(current: Y.Map<unknown>, saved: Y.Map<unknown>) {
  for (const key of Array.from(current.keys()))
    if (!saved.has(key)) current.delete(key);
  for (const [key, value] of saved)
    if (!sameValue(current.get(key), value)) current.set(key, value);
}

function addMissing(current: Y.Map<unknown>, saved: Y.Map<unknown>) {
  for (const [key, value] of saved)
    if (!current.has(key)) current.set(key, value);
}

function restoreBlocks(target: Entry, saved: ReturnType<typeof blocks>) {
  const fragment = target.doc.getXmlFragment("blocks");

  if (saved.length) blocksToYXmlFragment(blockEditor(), saved, fragment);
  else fragment.delete(0, fragment.length);
}

export function restoreContent(target: Entry, previous: Entry) {
  const saved = blocks(previous);

  target.doc.transact(() => {
    for (const name of RESTORED_MAPS)
      restoreMap(target.doc.getMap(name), previous.doc.getMap(name));
    addMissing(target.doc.getMap("files"), previous.doc.getMap("files"));
    restoreBlocks(target, saved);
  });
}

type Parsed = ReturnType<BlockNoteEditor["tryParseMarkdownToBlocks"]>;

export function writeMarkdown(
  e: Entry,
  text: string,
  adjust: (blocks: Parsed) => Parsed = (blocks) => blocks,
) {
  const editor = blockEditor(),
    fragment = e.doc.getXmlFragment("blocks");

  e.doc.transact(() => {
    fragment.delete(0, fragment.length);
    blocksToYXmlFragment(
      editor,
      adjust(editor.tryParseMarkdownToBlocks(text)),
      fragment,
    );
    e.doc.getMap("meta").set("text", text);
  });
}
