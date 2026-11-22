import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { command } from "./native";

export type RootTab = "home" | "pages";
export type ChromeAction =
  RootTab | "search" | "ai" | "add" | "back" | "favorite" | "more" | "settings";

export interface ChromeState {
  bar: boolean;
  tab: RootTab;
  top: "none" | "root" | "page";
  favorite: boolean;
  dark: boolean | null;
  view: string;
  behind: string | null;
  ai: boolean;
  labels: Record<ChromeAction, string>;
}

const OVERLAYS = ".panel, .popover, .aipanel, .inlineai, .viewer";
const ACTIONS: ReadonlySet<string> = new Set<ChromeAction>([
  "home",
  "pages",
  "search",
  "ai",
  "add",
  "back",
  "favorite",
  "more",
  "settings",
]);

const EDITABLE = "input, textarea, select, [contenteditable='true']";
const TEXT_FIELD =
  "input:not([type=checkbox], [type=radio], [type=range], [type=file]), textarea";
const KEEPS_KEYBOARD =
  "input, textarea, select, button, a, label, summary, .composer, [contenteditable='true'], [role=button], [role=option], [role=menuitem]";
const DRAG_DISMISS = 12;

export function watchOverlays(change: (covered: boolean) => void) {
  let frame = 0;
  const check = () => {
    frame = 0;
    change(!!document.querySelector(OVERLAYS));
  };
  const observer = new MutationObserver(() => {
    frame ||= requestAnimationFrame(check);
  });

  observer.observe(document.body, { childList: true, subtree: true });
  check();

  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
}

function focusedField() {
  const active = document.activeElement;

  return active instanceof HTMLElement && active.matches(TEXT_FIELD)
    ? active
    : null;
}

function hideKeyboard() {
  focusedField()?.blur();
}

export function dismissKeyboardOnTouch() {
  let start: Touch | null = null;
  let moved = false;
  const begin = (e: TouchEvent) => {
    start = e.touches.length === 1 ? e.touches[0] : null;
    moved = false;
  };
  const move = (e: TouchEvent) => {
    const touch = e.touches[0];

    if (!start || moved || !touch) return;
    if (Math.abs(touch.clientY - start.clientY) < DRAG_DISMISS) return;
    moved = true;
    const target = e.target instanceof Element ? e.target : null;

    if (!target?.closest(EDITABLE)) hideKeyboard();
  };
  const end = (e: TouchEvent) => {
    const target = e.target instanceof Element ? e.target : null;

    if (start && !moved && target && !target.closest(KEEPS_KEYBOARD))
      hideKeyboard();
    start = null;
  };

  document.addEventListener("touchstart", begin, { passive: true });
  document.addEventListener("touchmove", move, { passive: true });
  document.addEventListener("touchend", end, { passive: true });

  return () => {
    document.removeEventListener("touchstart", begin);
    document.removeEventListener("touchmove", move);
    document.removeEventListener("touchend", end);
  };
}

export async function showChrome(state: ChromeState) {
  if (!isTauri()) return false;

  try {
    return await command<boolean>("chrome", { state });
  } catch {
    return false;
  }
}

export async function rememberScreen(key: string | undefined) {
  if (!key || !isTauri()) return;
  await command<boolean>("remember_screen", { key }).catch(() => false);
}

export function onChromeAction(handle: (action: ChromeAction) => void) {
  if (!isTauri()) return () => {};

  let live = true;
  const attached = listen<string>("chrome", (event) => {
    if (live && ACTIONS.has(event.payload))
      handle(event.payload as ChromeAction);
  });

  return () => {
    live = false;
    void attached.then((stop) => stop());
  };
}

export function followViewport() {
  const viewport = window.visualViewport;

  if (!viewport) return () => {};

  const root = document.documentElement;
  const sync = () => {
    const covered = root.clientHeight - viewport.height - viewport.offsetTop;

    root.style.setProperty("--app-height", viewport.height + "px");
    root.style.setProperty("--keyboard", Math.max(0, covered) + "px");
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  };

  sync();
  viewport.addEventListener("resize", sync);
  viewport.addEventListener("scroll", sync);

  return () => {
    viewport.removeEventListener("resize", sync);
    viewport.removeEventListener("scroll", sync);
    root.style.removeProperty("--app-height");
    root.style.removeProperty("--keyboard");
  };
}
