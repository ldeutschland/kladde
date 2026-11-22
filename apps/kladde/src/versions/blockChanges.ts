import type { blocks } from "../notebook/content";

export type Block = ReturnType<typeof blocks>[number];

export interface IndexedBlock {
  block: Block;
  siblings: Block[];
  parent: string;
}

export type BlockIndex = Map<string, IndexedBlock>;

export interface BlockChange {
  id: string;
  left: IndexedBlock | undefined;
  right: IndexedBlock | undefined;
}

export function indexBlocks(
  list: Block[],
  index: BlockIndex = new Map(),
  parent = "",
) {
  for (const block of list) {
    index.set(block.id, { block, siblings: list, parent });
    indexBlocks(block.children, index, block.id);
  }

  return index;
}

function commonPositions(index: BlockIndex, other: BlockIndex) {
  const counts = new Map<string, number>();
  const positions = new Map<string, number>();

  for (const [id, { parent }] of index) {
    if (other.get(id)?.parent !== parent) continue;
    const position = counts.get(parent) ?? 0;

    positions.set(id, position);
    counts.set(parent, position + 1);
  }

  return positions;
}

function withoutChildren(block: Block) {
  return JSON.stringify({ ...block, children: [] });
}

function orphaned(
  change: BlockChange,
  previous: BlockIndex,
  current: BlockIndex,
) {
  const { left, right } = change;

  if (left?.parent && !current.has(left.parent)) return true;

  return !!right?.parent && !previous.has(right.parent);
}

export function compareBlocks(previous: BlockIndex, current: BlockIndex) {
  const oldPositions = commonPositions(previous, current);
  const newPositions = commonPositions(current, previous);
  const samePlace = (id: string) =>
    oldPositions.get(id) === newPositions.get(id);
  const unchanged = ({ id, left, right }: BlockChange) =>
    !!left &&
    !!right &&
    left.parent === right.parent &&
    withoutChildren(left.block) === withoutChildren(right.block) &&
    samePlace(id);
  const changes: BlockChange[] = [];

  for (const id of new Set([...previous.keys(), ...current.keys()])) {
    const change = { id, left: previous.get(id), right: current.get(id) };

    if (orphaned(change, previous, current) || unchanged(change)) continue;
    changes.push(change);
  }

  return { changes, samePlace };
}
