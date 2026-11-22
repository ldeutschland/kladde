export const BLOCK_SELECTOR = ".bn-block-outer[data-id]";
const CONTENT_SELECTOR = ":scope > .bn-block > .bn-block-content";
const SELECTION_BLOCKERS = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "label",
  "[contenteditable='true']",
  "[role='dialog']",
  "[role='menu']",
  ".pagehead",
  ".properties",
  ".database",
  ".inlinedb",
  ".backlinks",
  ".subpages",
  ".cover",
  ".keyboardbar",
  ".bn-side-menu",
  ".bn-toolbar",
  ".bn-suggestion-menu",
  "[data-floating-ui-portal]",
].join(",");

export interface Area {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function scrollParent(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;

    if (overflow === "auto" || overflow === "scroll") return node;
  }

  return document.documentElement;
}

export function startsSelection(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;

  return !target.closest(SELECTION_BLOCKERS);
}

export function blockElements(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
}

export function findBlock(root: HTMLElement, id: string) {
  return root.querySelector<HTMLElement>(
    `${BLOCK_SELECTOR}[data-id="${CSS.escape(id)}"]`,
  );
}

export function contentRect(block: HTMLElement) {
  const content = block.querySelector(CONTENT_SELECTOR) ?? block;

  return content.getBoundingClientRect();
}

export function outermost(elements: HTMLElement[]) {
  return elements.filter(
    (element) =>
      !elements.some((other) => other !== element && other.contains(element)),
  );
}

export function blocksBetween(root: HTMLElement, top: number, bottom: number) {
  const hits = blockElements(root).filter((block) => {
    const rect = contentRect(block);

    return rect.height > 0 && rect.bottom > top && rect.top < bottom;
  });

  return outermost(hits).map((block) => block.dataset.id ?? "");
}

export function pickedAreas(root: HTMLElement, picked: string[]): Area[] {
  const frame = root.getBoundingClientRect();

  return picked.flatMap((id) => {
    const element = findBlock(root, id);

    if (!element) return [];
    const rect = element.getBoundingClientRect();

    return [
      {
        top: rect.top - frame.top,
        left: rect.left - frame.left,
        width: rect.width,
        height: rect.height,
      },
    ];
  });
}

export function blurActive() {
  const active = document.activeElement;

  if (active instanceof HTMLElement) active.blur();
}
