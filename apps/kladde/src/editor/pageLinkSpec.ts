import {
  createInlineContentSpec,
  type CustomInlineContentConfig,
} from "@blocknote/core";
import type { Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { linkedPage, pageIdOf, pageLink } from "../notebook/links";

export interface PageLinkContext {
  book: Notebook;
  t: T;
  open?: (id: string, inNewTab?: boolean) => void;
  notify?: (text: string) => void;
}

const IMAGE_ICON = "kladde-file:";
const UNNAMED = "↗";
const ANCHOR_PRIORITY = 60;
const contexts = new WeakMap<object, PageLinkContext>();
let hiddenLinks: ((id: string) => boolean) | null = null;

const pageLinkConfig = {
  type: "pageLink",
  propSchema: { page: { default: "" } },
  content: "none",
} as const satisfies CustomInlineContentConfig;

export function setPageLinkContext(editor: object, context: PageLinkContext) {
  contexts.set(editor, context);
}

export function pageLinkContextOf(editor: object) {
  return contexts.get(editor);
}

function pageOf(context: PageLinkContext | undefined, id: string | null) {
  return id ? context?.book.pages.get(id) : undefined;
}

function labelOf(context: PageLinkContext | undefined, page: Page | undefined) {
  if (!context) return UNNAMED;
  if (!page) return context.t("pageMissing");

  return page.title || context.t("untitled");
}

function emojiOf(page: Page | undefined) {
  return page?.icon && !page.icon.startsWith(IMAGE_ICON) ? page.icon : "";
}

function stateOf(page: Page | undefined) {
  if (!page) return "missing";

  return page.archived ? "trashed" : "listed";
}

function anchorTo(id: string | null) {
  const anchor = document.createElement("a");

  if (id) anchor.setAttribute("href", pageLink(id));

  return anchor;
}

function span(className: string) {
  const element = document.createElement("span");

  element.className = className;

  return element;
}

function setText(element: HTMLElement, text: string) {
  if (element.textContent !== text) element.textContent = text;
}

function setData(element: HTMLElement, key: string, value: string) {
  if (element.dataset[key] !== value) element.dataset[key] = value;
}

function renderPageLink(value: string, editor: object, live: boolean) {
  const id = pageIdOf(value);
  const context = contexts.get(editor);
  const anchor = anchorTo(id);
  const icon = span("pagelinkicon");
  const title = span("pagelinktitle");
  const show = () => {
    const page = pageOf(context, id);

    setText(icon, emojiOf(page));
    setText(title, labelOf(context, page));
    setData(anchor, "kind", page?.kind === "database" ? "database" : "page");
    setData(anchor, "state", stateOf(page));
  };

  anchor.className = "pagelink";
  anchor.draggable = false;
  icon.setAttribute("aria-hidden", "true");
  anchor.append(icon, title);
  show();
  if (!live || !context) return { dom: anchor };

  return { dom: anchor, destroy: context.book.subscribe(show) };
}

export function withLinksHidden<Converted>(
  hidden: (id: string) => boolean,
  convert: () => Converted,
) {
  const outer = hiddenLinks;

  hiddenLinks = hidden;

  try {
    return convert();
  } finally {
    hiddenLinks = outer;
  }
}

function hiddenLabel(context: PageLinkContext | undefined) {
  const label = span("pagelinktitle");

  label.textContent = context ? context.t("aiExcludedChip") : UNNAMED;

  return label;
}

function exportPageLink(value: string, editor: object) {
  const id = pageIdOf(value);
  const context = contexts.get(editor);

  if (id && hiddenLinks?.(id)) return { dom: hiddenLabel(context) };
  const anchor = anchorTo(id);

  anchor.textContent = labelOf(context, pageOf(context, id));

  return { dom: anchor };
}

function pageOfAnchor(element: HTMLElement) {
  const page = linkedPage(element.getAttribute("href") ?? "");

  return page ? { page } : false;
}

const spec = createInlineContentSpec(pageLinkConfig, {
  render: (inlineContent, _update, editor, _node, getPos) =>
    renderPageLink(inlineContent.props.page, editor, getPos() !== undefined),
  toExternalHTML: (inlineContent, editor) =>
    exportPageLink(inlineContent.props.page, editor),
});

export const pageLinkSpec = {
  ...spec,
  implementation: {
    ...spec.implementation,
    node: spec.implementation.node.extend({
      parseHTML() {
        return [
          { tag: "a[href]", priority: ANCHOR_PRIORITY, getAttrs: pageOfAnchor },
          ...(this.parent?.() ?? []),
        ];
      },
    }),
  },
};
