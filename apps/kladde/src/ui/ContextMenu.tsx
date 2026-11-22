import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ClipboardPaste,
  Copy,
  Scissors,
  TextSelect,
  type LucideIcon,
} from "lucide-react";
import type { T } from "../locale/locale";

export interface MenuAction {
  label: string;
  icon: LucideIcon;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}
export type MenuEntry = MenuAction | "separator";
interface OpenMenu {
  serial: number;
  x: number;
  y: number;
  entries: MenuEntry[];
}
interface PointerPosition {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
}
type TextField = HTMLInputElement | HTMLTextAreaElement;

const SCREEN_EDGE = 8;
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "number",
  "password",
]);
const MODIFIER_KEYS = new Set(["Shift", "Meta", "Control", "Alt", "CapsLock"]);

let current: OpenMenu | null = null;
let opened = 0;
const listeners = new Set<() => void>();

function publish(next: OpenMenu | null) {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function snapshot() {
  return current;
}

function withoutStraySeparators(entries: MenuEntry[]) {
  return entries.filter(
    (entry, index) =>
      entry !== "separator" ||
      (index > 0 &&
        index < entries.length - 1 &&
        entries[index - 1] !== "separator"),
  );
}

export function showContextMenu(e: PointerPosition, entries: MenuEntry[]) {
  e.preventDefault();
  const usable = withoutStraySeparators(entries);

  if (!usable.length) {
    publish(null);

    return;
  }

  opened++;
  publish({ serial: opened, x: e.clientX, y: e.clientY, entries: usable });
}

export function closeContextMenu() {
  publish(null);
}

function isTextField(element: HTMLElement): element is TextField {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  );
}

function editableTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const field = target.closest<HTMLElement>(
    "input, textarea, [contenteditable='true']",
  );

  if (field instanceof HTMLInputElement && !TEXT_INPUT_TYPES.has(field.type))
    return null;

  return field;
}

function hasSelection(field: HTMLElement) {
  if (!isTextField(field)) return !!getSelection()?.toString();
  if (field.selectionStart === null) return !!field.value;

  return field.selectionStart !== field.selectionEnd;
}

function isLocked(field: HTMLElement) {
  return isTextField(field) && (field.readOnly || field.disabled);
}

function editorHandledPaste(field: HTMLElement, text: string) {
  const data = new DataTransfer();

  data.setData("text/plain", text);
  const event = new ClipboardEvent("paste", {
    clipboardData: data,
    bubbles: true,
    cancelable: true,
  });

  return !field.dispatchEvent(event);
}

async function paste(field: HTMLElement) {
  const text = await navigator.clipboard.readText().catch(() => "");

  if (!text || !field.isConnected) return;
  field.focus();
  if (!isTextField(field) && editorHandledPaste(field, text)) return;
  document.execCommand("insertText", false, text);
}

function selectAll(field: HTMLElement) {
  field.focus();
  if (isTextField(field)) field.select();
  else document.execCommand("selectAll");
}

function copySelection() {
  document.execCommand("copy");
}

function selectionEntries(t: T): MenuEntry[] {
  if (!getSelection()?.toString()) return [];

  return [{ label: t("copy"), icon: Copy, hint: "⌘C", run: copySelection }];
}

export function editingEntries(target: EventTarget | null, t: T): MenuEntry[] {
  const field = editableTarget(target);

  if (!field) return selectionEntries(t);
  const selected = hasSelection(field);
  const locked = isLocked(field);
  const secret = field instanceof HTMLInputElement && field.type === "password";

  return [
    {
      label: t("cut"),
      icon: Scissors,
      hint: "⌘X",
      disabled: !selected || locked || secret,
      run: () => document.execCommand("cut"),
    },
    {
      label: t("copy"),
      icon: Copy,
      hint: "⌘C",
      disabled: !selected || secret,
      run: copySelection,
    },
    {
      label: t("paste"),
      icon: ClipboardPaste,
      hint: "⌘V",
      disabled: locked,
      run: () => void paste(field),
    },
    "separator",
    {
      label: t("selectAll"),
      icon: TextSelect,
      hint: "⌘A",
      run: () => selectAll(field),
    },
  ];
}

function fitOnScreen(start: number, size: number, limit: number) {
  if (start + size + SCREEN_EDGE <= limit) return start;

  return Math.max(
    SCREEN_EDGE,
    Math.min(start - size, limit - size - SCREEN_EDGE),
  );
}

function enabledIndexes(entries: MenuEntry[]) {
  return entries.flatMap((entry, index) =>
    entry !== "separator" && !entry.disabled ? [index] : [],
  );
}

function stepThrough(enabled: number[], active: number, delta: number) {
  if (!enabled.length) return -1;
  const position = enabled.indexOf(active);

  if (position === -1)
    return delta > 0 ? enabled[0] : enabled[enabled.length - 1];

  return enabled[(position + delta + enabled.length) % enabled.length];
}

function choose(action: MenuAction) {
  closeContextMenu();
  action.run();
}

function FloatingMenu({ menu }: { menu: OpenMenu }) {
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState({ x: menu.x, y: menu.y });

  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect();

    if (!rect) return;
    setPosition({
      x: fitOnScreen(menu.x, rect.width, innerWidth),
      y: fitOnScreen(menu.y, rect.height, innerHeight),
    });
  }, [menu]);

  useEffect(() => {
    const enabled = enabledIndexes(menu.entries);

    function keys(e: KeyboardEvent) {
      if (MODIFIER_KEYS.has(e.key)) return;

      if (e.key === "ArrowDown" || e.key === "ArrowUp")
        setActive(stepThrough(enabled, active, e.key === "ArrowDown" ? 1 : -1));
      else if (e.key === "Enter" && active >= 0)
        choose(menu.entries[active] as MenuAction);
      else {
        closeContextMenu();
        if (e.key !== "Escape") return;
      }

      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function outside(e: PointerEvent) {
      if (!box.current?.contains(e.target as Node)) closeContextMenu();
    }

    window.addEventListener("keydown", keys, true);
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", closeContextMenu, true);
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("blur", closeContextMenu);

    return () => {
      window.removeEventListener("keydown", keys, true);
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", closeContextMenu, true);
      window.removeEventListener("resize", closeContextMenu);
      window.removeEventListener("blur", closeContextMenu);
    };
  }, [menu, active]);

  return (
    <div
      ref={box}
      className="contextmenu menu"
      role="menu"
      style={{ left: position.x, top: position.y }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.entries.map((entry, index) =>
        entry === "separator" ? (
          <hr key={index} />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            className={entry.danger ? "danger" : undefined}
            disabled={entry.disabled}
            data-active={index === active || undefined}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(entry)}
          >
            <entry.icon />
            <span className="grow">{entry.label}</span>
            {entry.hint && <kbd>{entry.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

export function ContextMenuHost({ t }: { t: T }) {
  const menu = useSyncExternalStore(subscribe, snapshot);

  useEffect(() => {
    function fallback(e: MouseEvent) {
      if (e.defaultPrevented) return;
      if (import.meta.env.DEV && e.shiftKey) return;
      showContextMenu(e, editingEntries(e.target, t));
    }

    document.addEventListener("contextmenu", fallback);

    return () => document.removeEventListener("contextmenu", fallback);
  }, [t]);
  useEffect(() => closeContextMenu, []);
  if (!menu) return null;

  return <FloatingMenu key={menu.serial} menu={menu} />;
}
