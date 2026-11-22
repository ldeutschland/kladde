import { useEffect } from "react";
import { closeTab, cycleTab, type TabSet } from "./tabs";

const SHORTCUT_KEYS = ["p", "k", "n", "[", "]", "\\", "j", "l"];

export interface Shortcuts {
  tabs: TabSet | null;
  switchTo: (next: TabSet | null) => void;
  newTab: () => void;
  run: (key: string) => void;
}

function tabShortcut(e: KeyboardEvent, key: string, shortcuts: Shortcuts) {
  const { tabs, switchTo } = shortcuts;

  if (!tabs) return false;

  if (key === "tab" && e.ctrlKey) {
    switchTo(cycleTab(tabs, e.shiftKey ? -1 : 1));

    return true;
  }

  if (e.shiftKey || e.altKey) return false;

  if (key === "t") {
    shortcuts.newTab();

    return true;
  }

  if (key !== "w" || tabs.list.length < 2) return false;
  switchTo(closeTab(tabs, tabs.active));

  return true;
}

function handledElsewhere(e: KeyboardEvent, key: string) {
  const inEditor =
    e.target instanceof Element && !!e.target.closest(".bn-editor");

  if (key === "k" && inEditor) return true;
  if (key === "j" && inEditor && !e.shiftKey) return true;

  return key === "l" && !e.shiftKey;
}

export function useShortcuts(shortcuts: Shortcuts) {
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();

      if (tabShortcut(e, key, shortcuts)) {
        e.preventDefault();

        return;
      }

      if (handledElsewhere(e, key) || !SHORTCUT_KEYS.includes(key)) return;
      e.preventDefault();
      shortcuts.run(key);
    }

    window.addEventListener("keydown", keys);

    return () => window.removeEventListener("keydown", keys);
  });
}
