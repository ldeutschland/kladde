import type { KeyboardEvent } from "react";
import type { Zoom } from "./useZoom";

const TYPING = "input, textarea, select, [contenteditable='true']";

export function isTyping() {
  return !!document.activeElement?.matches(TYPING);
}

export function viewerKeys(
  event: KeyboardEvent<HTMLElement>,
  zoom: Zoom,
  editing: boolean,
  history: { undo: () => void; redo: () => void },
) {
  if (isTyping() || event.nativeEvent.isComposing) return false;
  const command = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  const actions: Record<string, () => void> = {
    "=": zoom.zoomIn,
    "+": zoom.zoomIn,
    "-": zoom.zoomOut,
    "0": zoom.fit,
  };

  if (command && actions[key]) actions[key]();
  else if (command && key === "z" && editing)
    (event.shiftKey ? history.redo : history.undo)();
  else return false;
  event.preventDefault();

  return true;
}
