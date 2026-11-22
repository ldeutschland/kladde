import { blocks, blockEditor } from "../notebook/content";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import type { Entry } from "../notebook/notebook";

export function blockReview(original: Entry | null, draft: Entry) {
  if (!original || !(draft.kind === "page" || draft.kind === "row")) return [];
  const before = blocks(original),
    after = blocks(draft);
  const originals = new Map(before.map((b) => [b.id, b]));
  const updates = new Map(after.map((b) => [b.id, b]));
  const ids = new Set([...originals.keys(), ...updates.keys()]);
  const oldIndex = new Map(before.map((b, i) => [b.id, i]));
  const newIndex = new Map(after.map((b, i) => [b.id, i]));
  const edited = [];

  for (const id of ids) {
    const left = originals.get(id),
      right = updates.get(id);

    if (
      JSON.stringify(left) === JSON.stringify(right) &&
      oldIndex.get(id) === newIndex.get(id)
    )
      continue;
    edited.push({
      id,
      before: left ? blockEditor().blocksToMarkdownLossy([left]) : "",
      after: right ? blockEditor().blocksToMarkdownLossy([right]) : "",
    });
  }

  return edited;
}
export function keepOriginalBlocks(
  original: Entry,
  draft: Entry,
  rejected: Set<string>,
) {
  const before = blocks(original),
    after = blocks(draft);

  if (
    !before.some((b) => rejected.has(b.id)) &&
    !after.some((b) => rejected.has(b.id))
  )
    return;
  const merged = after.filter((b) => !rejected.has(b.id));

  for (let i = 0; i < before.length; i++) {
    const block = before[i];

    if (!rejected.has(block.id)) continue;
    let position = 0;

    for (let j = i - 1; j >= 0; j--) {
      const previous = merged.findIndex((b) => b.id === before[j].id);

      if (previous !== -1) {
        position = previous + 1;
        break;
      }
    }

    merged.splice(position, 0, block);
  }

  draft.doc.transact(() => {
    const fragment = draft.doc.getXmlFragment("blocks");

    fragment.delete(0, fragment.length);
    blocksToYXmlFragment(blockEditor(), merged, fragment);
    draft.doc
      .getMap("meta")
      .set("text", blockEditor().blocksToMarkdownLossy(merged));
  });
}
