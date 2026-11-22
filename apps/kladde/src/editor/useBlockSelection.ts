import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import {
  blurActive,
  pickedAreas,
  scrollParent,
  type Area,
} from "./selectionDom";
import { listenForDragSelect } from "./dragSelect";
import { listenForSelectionKeys } from "./selectionKeys";

function useRelayout(
  editor: BlockNoteEditor,
  section: RefObject<HTMLElement | null>,
  setPicked: (update: (ids: string[]) => string[]) => void,
) {
  const [layout, relayout] = useState(0);

  useEffect(() => {
    const root = section.current;

    if (!root) return;
    const stopChange = editor.onChange(() => {
      relayout((count) => count + 1);
      setPicked((ids) => ids.filter((id) => editor.getBlock(id)));
    });
    const observer = new ResizeObserver(() => relayout((count) => count + 1));

    observer.observe(root);

    return () => {
      stopChange();
      observer.disconnect();
    };
  }, [editor, section]);

  return layout;
}

export function useBlockSelection(
  editor: BlockNoteEditor,
  section: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [picked, setPicked] = useState<string[]>([]);
  const [box, setBox] = useState<Area | null>(null);
  const [marks, setMarks] = useState<Area[]>([]);
  const pickedRef = useRef(picked);

  pickedRef.current = picked;
  const clear = useCallback(() => setPicked([]), []);
  const pick = useCallback((ids: string[]) => {
    blurActive();
    window.getSelection()?.removeAllRanges();
    setPicked(ids);
  }, []);
  const layout = useRelayout(editor, section, setPicked);

  useLayoutEffect(() => {
    const root = section.current;

    setMarks(root && picked.length ? pickedAreas(root, picked) : []);
  }, [picked, layout, section]);

  useEffect(() => {
    const root = section.current;

    if (!root || !enabled) return;

    return listenForDragSelect({
      root,
      scroller: scrollParent(root),
      picked: () => pickedRef.current,
      setPicked,
      setBox,
    });
  }, [enabled, section]);

  useEffect(() => {
    if (!picked.length) return;

    return listenForSelectionKeys({
      editor,
      root: section.current,
      picked,
      setPicked,
    });
  }, [picked, editor, section]);

  return { picked, box, marks, pick, clear };
}
