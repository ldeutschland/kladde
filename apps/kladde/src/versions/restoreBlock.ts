import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { blockEditor, blocks } from "../notebook/content";
import type { Entry } from "../notebook/notebook";
import type { T } from "../locale/locale";
import {
  indexBlocks,
  type Block,
  type BlockIndex,
  type IndexedBlock,
} from "./blockChanges";

export interface RestoreContext {
  entry: Entry;
  old: Entry;
  previous: BlockIndex;
  samePlace: (id: string) => boolean;
  t: T;
}

const FILE_REF = /kladde-file:([0-9a-f-]{36})/g;

function savedCopy(
  before: IndexedBlock,
  after: IndexedBlock | undefined,
  live: BlockIndex,
) {
  const saved = structuredClone(before.block);

  if (after) {
    saved.children = after.block.children;

    return saved;
  }

  const pending = [saved];

  for (const block of pending) {
    block.children = block.children.filter((child) => !live.has(child.id));
    pending.push(...block.children);
  }

  return saved;
}

function insertPosition(before: IndexedBlock, siblings: Block[]) {
  const at = before.siblings.indexOf(before.block);

  for (let position = at - 1; position >= 0; position--) {
    const anchor = siblings.findIndex(
      (block) => block.id === before.siblings[position].id,
    );

    if (anchor !== -1) return anchor + 1;
  }

  return 0;
}

function copyFileRefs(block: Block, old: Entry, entry: Entry) {
  const files = entry.doc.getMap("files");

  for (const [, key] of JSON.stringify(block).matchAll(FILE_REF)) {
    const meta = old.doc.getMap("files").get(key);

    if (!files.has(key) && meta) files.set(key, meta);
  }
}

function writeBlocks(
  { entry, old }: RestoreContext,
  before: IndexedBlock | undefined,
  live: Block[],
) {
  const editor = blockEditor();

  entry.doc.transact(() => {
    if (before) copyFileRefs(before.block, old, entry);
    blocksToYXmlFragment(editor, live, entry.doc.getXmlFragment("blocks"));
    entry.doc.getMap("meta").set("text", editor.blocksToMarkdownLossy(live));
  });
}

export function restoreBlock(context: RestoreContext, id: string) {
  const { entry, previous, samePlace, t } = context;
  const live = blocks(entry);
  const index = indexBlocks(live);
  const before = previous.get(id);
  const after = index.get(id);
  const siblings = before?.parent
    ? index.get(before.parent)?.block.children
    : live;

  if (!siblings) return false;
  if (before && after && indexBlocks(after.block.children).has(before.parent))
    throw Error(t("restoreParentFirst"));
  const currentPosition = after ? after.siblings.indexOf(after.block) : -1;

  if (after) after.siblings.splice(currentPosition, 1);

  if (before) {
    const saved = savedCopy(before, after, index);
    const unmoved = !!after && before.parent === after.parent && samePlace(id);
    const position = unmoved
      ? currentPosition
      : insertPosition(before, siblings);

    siblings.splice(position, 0, saved);
  }

  writeBlocks(context, before, live);

  return true;
}
