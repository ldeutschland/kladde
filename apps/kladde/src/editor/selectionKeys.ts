import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import {
  blockElements,
  contentRect,
  findBlock,
  outermost,
  startsSelection,
} from "./selectionDom";

type AnyBlock = PartialBlock & { id?: string; children?: AnyBlock[] };

export interface SelectionContext {
  editor: BlockNoteEditor;
  root: HTMLElement | null;
  picked: string[];
  setPicked: (ids: string[]) => void;
}

function withoutIds(block: AnyBlock): AnyBlock {
  const { children, ...rest } = block;

  delete rest.id;

  return { ...rest, children: (children ?? []).map(withoutIds) };
}

function writeClipboard(html: string, text: string) {
  const plain = () => navigator.clipboard?.writeText(text).catch(() => {});

  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write)
    return void plain();
  const item = new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([text], { type: "text/plain" }),
  });

  void navigator.clipboard.write([item]).catch(plain);
}

function isPrintable(event: KeyboardEvent) {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey;
}

function pickedBlocks({ editor, picked }: SelectionContext) {
  return picked
    .map((id) => editor.getBlock(id))
    .filter((block): block is NonNullable<typeof block> => !!block);
}

function copy(context: SelectionContext) {
  const { editor } = context;
  const chosen = pickedBlocks(context);

  writeClipboard(
    editor.blocksToHTMLLossy(chosen),
    editor.blocksToMarkdownLossy(chosen),
  );
}

function duplicate(context: SelectionContext) {
  const chosen = pickedBlocks(context);
  const last = chosen.at(-1);

  if (!last) return;
  const copies = context.editor.insertBlocks(
    chosen.map((block) => withoutIds(block as AnyBlock)),
    last.id,
    "after",
  );

  context.setPicked(copies.map((block) => block.id));
}

function outermostIds(root: HTMLElement, ids: string[]) {
  const elements = ids
    .map((id) => findBlock(root, id))
    .filter((item): item is HTMLElement => !!item);

  return outermost(elements).map((element) => element.dataset.id ?? "");
}

function nextOutsidePick(
  root: HTMLElement,
  picked: string[],
  order: string[],
  from: number,
  direction: 1 | -1,
) {
  for (let index = from + direction; order[index]; index += direction) {
    const candidate = order[index];

    if (outermostIds(root, [...picked, candidate]).includes(candidate))
      return candidate;
  }

  return undefined;
}

function step(context: SelectionContext, direction: 1 | -1, extend: boolean) {
  const { root, picked } = context;

  if (!root) return;
  const order = blockElements(root)
    .filter((element) => contentRect(element).height > 0)
    .map((element) => element.dataset.id ?? "");
  const positions = picked
    .map((id) => order.indexOf(id))
    .filter((position) => position >= 0);

  if (!positions.length) return;
  const edge = direction > 0 ? Math.max(...positions) : Math.min(...positions);

  if (!extend) {
    const next = order[edge + direction];

    if (next) context.setPicked([next]);

    return;
  }

  const next = nextOutsidePick(root, picked, order, edge, direction);

  if (next) context.setPicked(outermostIds(root, [...picked, next]));
}

function remove(context: SelectionContext) {
  context.editor.removeBlocks(context.picked);
  context.setPicked([]);
}

function leaveToText(context: SelectionContext) {
  const last = context.picked.at(-1);

  context.setPicked([]);
  if (last) context.editor.setTextCursorPosition(last, "end");
  context.editor.focus();
}

function commandFor(event: KeyboardEvent, context: SelectionContext) {
  const command = event.metaKey || event.ctrlKey;
  const lower = event.key.toLowerCase();

  if (event.key === "Escape") return () => context.setPicked([]);
  if (event.key === "Backspace" || event.key === "Delete")
    return () => remove(context);
  if (command && lower === "c") return () => copy(context);

  if (command && lower === "x")
    return () => {
      copy(context);
      remove(context);
    };

  if (command && lower === "d") return () => duplicate(context);
  if (command && lower === "a")
    return () =>
      context.setPicked(context.editor.document.map((block) => block.id));
  if (event.key === "ArrowUp" || event.key === "ArrowDown")
    return () =>
      step(context, event.key === "ArrowUp" ? -1 : 1, event.shiftKey);
  if (event.key === "Enter") return () => leaveToText(context);

  return null;
}

function typingInField() {
  const active = document.activeElement;

  return (
    active instanceof HTMLElement &&
    !!active.closest("input, textarea, [role='dialog']")
  );
}

export function listenForSelectionKeys(context: SelectionContext) {
  const key = (event: KeyboardEvent) => {
    if (typingInField()) return;
    const command = commandFor(event, context);

    if (!command) {
      if (isPrintable(event)) context.setPicked([]);

      return;
    }

    command();
    event.preventDefault();
    event.stopPropagation();
  };
  const pointerDown = (event: MouseEvent) => {
    if (event.shiftKey) return;
    if (!startsSelection(event.target)) context.setPicked([]);
  };

  window.addEventListener("keydown", key, true);
  window.addEventListener("mousedown", pointerDown, true);

  return () => {
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("mousedown", pointerDown, true);
  };
}
