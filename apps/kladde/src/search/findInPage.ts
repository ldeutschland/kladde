import { fold } from "./reveal";

const FOUND = "kladde-find";
const CURRENT = "kladde-find-current";
const BLOCK_TEXT = ".bn-editor .bn-block-content";
const SKIPPED_TEXT = "button, [aria-hidden='true']";
const EDITOR = ".bn-editor";
const VISIBLE_MARGIN = 64;

interface Piece {
  node: Text;
  text: string;
  from: number[];
  to: number[];
}

function textNodes(block: HTMLElement) {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;

    if (!node.parentElement?.closest(SKIPPED_TEXT)) nodes.push(node);
  }

  return nodes;
}

function evenPiece(node: Text, text: string): Piece {
  const from = Array.from({ length: text.length }, (_, at) => at);

  return { node, text, from, to: from.map((at) => at + 1) };
}

function piece(node: Text): Piece {
  const whole = fold(node.data);

  if (whole.length === node.data.length) return evenPiece(node, whole);
  const result: Piece = { node, text: "", from: [], to: [] };
  let at = 0;

  for (const char of node.data) {
    const folded = fold(char);

    for (let i = 0; i < folded.length; i++) {
      result.from.push(at);
      result.to.push(at + char.length);
    }

    result.text += folded;
    at += char.length;
  }

  return result;
}

function locate(pieces: Piece[], index: number): [Piece, number] {
  let rest = index;

  for (const found of pieces) {
    if (rest < found.text.length) return [found, rest];
    rest -= found.text.length;
  }

  const last = pieces[pieces.length - 1];

  return [last, last.text.length - 1];
}

function rangeOf(pieces: Piece[], start: number, end: number) {
  const [first, from] = locate(pieces, start);
  const [last, to] = locate(pieces, end - 1);
  const range = document.createRange();

  range.setStart(first.node, first.from[from]);
  range.setEnd(last.node, last.to[to]);

  return range;
}

function blockRanges(block: HTMLElement, term: string) {
  const pieces = textNodes(block).map(piece);
  const text = pieces.map((found) => found.text).join("");
  const ranges: Range[] = [];
  let at = text.indexOf(term);

  while (at >= 0) {
    ranges.push(rangeOf(pieces, at, at + term.length));
    at = text.indexOf(term, at + term.length);
  }

  return ranges;
}

export function findRanges(root: HTMLElement, query: string) {
  const term = fold(query);

  if (!term.trim()) return [];
  const blocks = root.querySelectorAll<HTMLElement>(BLOCK_TEXT);

  return Array.from(blocks).flatMap((block) => blockRanges(block, term));
}

export function firstInView(ranges: Range[], scroller: HTMLElement) {
  const top = scroller.getBoundingClientRect().top + VISIBLE_MARGIN;
  const index = ranges.findIndex((r) => r.getBoundingClientRect().top >= top);

  return Math.max(index, 0);
}

export function revealRange(range: Range | undefined, scroller: HTMLElement) {
  if (!range) return;
  const box = range.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();

  if (
    box.top >= view.top + VISIBLE_MARGIN &&
    box.bottom <= view.bottom - VISIBLE_MARGIN
  )
    return;
  scroller.scrollBy({ top: box.top - view.top - view.height / 2 });
}

export function paintFound(ranges: Range[], current: number) {
  if (!("highlights" in CSS)) return;
  const all = new Highlight();
  const shown = new Highlight();

  for (const range of ranges) all.add(range);
  if (ranges[current]) shown.add(ranges[current]);
  shown.priority = 1;
  CSS.highlights.set(FOUND, all);
  CSS.highlights.set(CURRENT, shown);
}

export function clearFound() {
  if (!("highlights" in CSS)) return;
  CSS.highlights.delete(FOUND);
  CSS.highlights.delete(CURRENT);
}

export function selectRange(range: Range | undefined) {
  const editor =
    range?.startContainer.parentElement?.closest<HTMLElement>(EDITOR);

  if (!range || !editor) return;
  editor.focus({ preventScroll: true });
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
}
