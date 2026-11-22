export interface Reveal {
  page: string;
  terms: string[];
  file?: string;
  index?: number;
  found?: string;
}

interface BlockTree {
  id: string;
  props: unknown;
  children: BlockTree[];
}

const FOUND_HIGHLIGHT = "kladde-found";
const FOUND_MS = 4000;

export function fold(text: string) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function findFileBlock<B extends BlockTree>(
  blocks: B[],
  file: string,
): B | undefined {
  const url = "kladde-file:" + file;

  for (const block of blocks) {
    if ((block.props as { url?: unknown }).url === url) return block;
    const inner = findFileBlock(block.children as B[], file);

    if (inner) return inner;
  }

  return undefined;
}

export function findTextBlock(root: HTMLElement, terms: string[]) {
  const wanted = terms.map(fold);
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>(".bn-block-content"),
    (element) => ({ element, text: fold(element.textContent ?? "") }),
  );
  const all = blocks.find(({ text }) => wanted.every((t) => text.includes(t)));
  const any = blocks.find(({ text }) => wanted.some((t) => text.includes(t)));

  return (all ?? any)?.element;
}

export function blockElement(root: HTMLElement, id: string) {
  return root.querySelector<HTMLElement>(
    `.bn-block-outer[data-id="${CSS.escape(id)}"] .bn-block-content`,
  );
}

function textNodes(block: HTMLElement) {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);

  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  return nodes;
}

function termRanges(node: Text, folded: string, term: string) {
  const ranges: Range[] = [];
  let at = folded.indexOf(term);

  while (at >= 0) {
    const range = document.createRange();

    range.setStart(node, at);
    range.setEnd(node, at + term.length);
    ranges.push(range);
    at = folded.indexOf(term, at + term.length);
  }

  return ranges;
}

function wordRanges(block: HTMLElement, terms: string[]) {
  return textNodes(block).flatMap((node) => {
    const folded = fold(node.data);

    if (folded.length !== node.data.length) return [];

    return terms.flatMap((term) => termRanges(node, folded, term));
  });
}

function foundRanges(block: HTMLElement, terms: string[]) {
  const words = wordRanges(block, terms.map(fold).filter(Boolean));

  if (words.length) return words;
  const whole = document.createRange();

  whole.selectNodeContents(block);

  return [whole];
}

export function showFound(block: HTMLElement, terms: string[]) {
  block.scrollIntoView({ block: "center" });
  if (!("highlights" in CSS)) return;
  const marked = new Highlight(...foundRanges(block, terms));

  CSS.highlights.set(FOUND_HIGHLIGHT, marked);
  setTimeout(() => {
    if (CSS.highlights.get(FOUND_HIGHLIGHT) === marked)
      CSS.highlights.delete(FOUND_HIGHLIGHT);
  }, FOUND_MS);
}
