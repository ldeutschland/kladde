import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import {
  handleEditorKey,
  type EditorKeyContext,
} from "../../src/editor/editorKeys";

let menuOpen = false;

function setup(overrides: Partial<EditorKeyContext> = {}, editor = {}) {
  const context = {
    editor: {
      getSelection: () => undefined,
      getTextCursorPosition: () => ({
        block: { id: "cursor", type: "paragraph", content: [] },
      }),
      getSelectedText: () => "",
      ...editor,
    },
    mobile: false,
    inlineOpen: false,
    aiReady: true,
    pickBlocks: vi.fn(),
    startInline: vi.fn(),
    ...overrides,
  };

  return context as typeof context & EditorKeyContext;
}

function press(
  context: EditorKeyContext,
  key: string,
  extra: Record<string, unknown> = {},
) {
  const event = {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: { closest: () => ({}) },
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...extra,
  };

  handleEditorKey(event as unknown as KeyboardEvent<HTMLElement>, context);

  return event;
}

beforeEach(() => {
  menuOpen = false;
  vi.stubGlobal("document", { querySelector: () => (menuOpen ? {} : null) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("editor keys", () => {
  it("selects the cursor block or the selected blocks with Escape on desktop", () => {
    const single = setup();
    const event = press(single, "Escape");

    expect(single.pickBlocks).toHaveBeenCalledWith(["cursor"]);
    expect(event.preventDefault).toHaveBeenCalled();
    const ranged = setup(
      {},
      { getSelection: () => ({ blocks: [{ id: "a" }, { id: "b" }] }) },
    );

    press(ranged, "Escape");
    expect(ranged.pickBlocks).toHaveBeenCalledWith(["a", "b"]);
  });

  it("leaves Escape alone on phones, with inline AI open or while a menu is open", () => {
    const phone = setup({ mobile: true });
    const inline = setup({ inlineOpen: true });
    const menu = setup();

    press(phone, "Escape");
    press(inline, "Escape");
    menuOpen = true;
    const event = press(menu, "Escape");

    for (const context of [phone, inline, menu])
      expect(context.pickBlocks).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("opens inline AI with Cmd+J or Ctrl+J but not with extra modifiers", () => {
    const context = setup();

    press(context, "j", { metaKey: true });
    press(context, "J", { ctrlKey: true });
    press(context, "j", { metaKey: true, shiftKey: true });
    press(context, "j", { ctrlKey: true, altKey: true });
    press(context, "j");
    expect(context.startInline).toHaveBeenCalledTimes(2);
  });

  it("opens inline AI with Space only on an empty line when AI is ready", () => {
    const ready = setup();

    press(ready, " ");
    expect(ready.startInline).toHaveBeenCalledOnce();
    const typed = setup(
      {},
      {
        getTextCursorPosition: () => ({
          block: { type: "paragraph", content: [{ text: "x" }] },
        }),
      },
    );
    const selected = setup({}, { getSelectedText: () => "word" });
    const heading = setup(
      {},
      {
        getTextCursorPosition: () => ({
          block: { type: "heading", content: [] },
        }),
      },
    );
    const off = setup({ aiReady: false });

    for (const context of [typed, selected, heading, off]) {
      press(context, " ");
      expect(context.startInline).not.toHaveBeenCalled();
    }

    press(ready, " ", { shiftKey: true });
    expect(ready.startInline).toHaveBeenCalledOnce();
  });

  it("ignores keys outside the editor and during text composition", () => {
    const context = setup();

    press(context, "j", { metaKey: true, target: { closest: () => null } });
    press(context, "j", {
      metaKey: true,
      nativeEvent: { isComposing: true },
    });
    press(context, "Escape", { nativeEvent: { isComposing: true } });
    expect(context.startInline).not.toHaveBeenCalled();
    expect(context.pickBlocks).not.toHaveBeenCalled();
  });
});
