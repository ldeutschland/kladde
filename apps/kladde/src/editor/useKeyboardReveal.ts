import { useEffect } from "react";
import type { BlockNoteEditor } from "@blocknote/core";

const SCROLLABLE = /auto|scroll/;

function scrollParent(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (SCROLLABLE.test(getComputedStyle(node).overflowY)) return node;
  }

  return null;
}

function revealCaret(editor: BlockNoteEditor) {
  if (!editor.isFocused()) return;
  const view = editor.prosemirrorView;
  const scroller = scrollParent(view.dom);

  if (!scroller) return;
  const caret = view.coordsAtPos(view.state.selection.head);
  const padding = parseFloat(getComputedStyle(scroller).scrollPaddingBottom);
  const bottom = scroller.getBoundingClientRect().bottom - (padding || 0);
  const hidden = caret.bottom - bottom;

  if (hidden > 0) scroller.scrollTop += hidden;
}

export function useKeyboardReveal(editor: BlockNoteEditor, mobile: boolean) {
  useEffect(() => {
    const viewport = window.visualViewport;

    if (!mobile || !viewport) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => revealCaret(editor));
    };

    viewport.addEventListener("resize", follow);

    return () => {
      viewport.removeEventListener("resize", follow);
      cancelAnimationFrame(frame);
    };
  }, [editor, mobile]);
}
