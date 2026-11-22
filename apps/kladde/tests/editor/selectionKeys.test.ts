import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectionContext } from "../../src/editor/selectionKeys";

const dom = vi.hoisted(() => ({
  heights: {} as Record<string, number>,
  order: [] as string[],
  selectable: true,
}));

vi.mock("../../src/editor/selectionDom", () => ({
  blockElements: () => dom.order.map((id) => ({ dataset: { id } })),
  contentRect: (element: { dataset: { id: string } }) => ({
    height: dom.heights[element.dataset.id] ?? 20,
  }),
  findBlock: (_root: unknown, id: string) =>
    dom.order.includes(id) ? { dataset: { id } } : null,
  outermost: (elements: { dataset: { id: string } }[]) =>
    elements.filter((element) => element.dataset.id !== "child"),
  startsSelection: () => dom.selectable,
}));

const { listenForSelectionKeys } =
  await import("../../src/editor/selectionKeys");

class FakeHTMLElement {
  constructor(private readonly field: boolean) {}
  closest() {
    return this.field ? {} : null;
  }
}

type Listener = (event: unknown) => void;

let listeners: Map<string, Listener>;
let activeElement: unknown;
let copied: string[];

const BLOCKS: Record<string, { id: string; children?: unknown[] }> = {
  a: { id: "a" },
  b: {
    id: "b",
    children: [{ id: "b1", children: [{ id: "b1x" }] }],
  },
  c: { id: "c" },
};

function setup(picked: string[]) {
  let copies = 0;
  const editor = {
    document: Object.values(BLOCKS),
    getBlock: (id: string) => BLOCKS[id],
    blocksToHTMLLossy: (blocks: { id: string }[]) =>
      blocks.map((block) => `<p>${block.id}</p>`).join(""),
    blocksToMarkdownLossy: (blocks: { id: string }[]) =>
      blocks.map((block) => block.id).join("\n"),
    insertBlocks: vi.fn<
      (blocks: unknown[], anchor: string, place: string) => { id: string }[]
    >((blocks) => blocks.map(() => ({ id: `copy${++copies}` }))),
    removeBlocks: vi.fn(),
    setTextCursorPosition: vi.fn(),
    focus: vi.fn(),
  };
  const context = {
    editor,
    root: {},
    picked,
    setPicked: vi.fn((ids: string[]) => (context.picked = ids)),
  };
  const stop = listenForSelectionKeys(context as unknown as SelectionContext);

  return { ...context, context, stop };
}

function key(name: string, extra: Record<string, unknown> = {}) {
  const event = {
    key: name,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...extra,
  };

  listeners.get("keydown")!(event);

  return event;
}

beforeEach(() => {
  listeners = new Map();
  activeElement = null;
  copied = [];
  dom.heights = {};
  dom.order = ["a", "b", "child", "c"];
  dom.selectable = true;
  vi.stubGlobal("HTMLElement", FakeHTMLElement);
  vi.stubGlobal("document", {
    get activeElement() {
      return activeElement;
    },
  });
  vi.stubGlobal("navigator", {
    clipboard: {
      writeText: async (text: string) => void copied.push(text),
    },
  });
  vi.stubGlobal("window", {
    addEventListener: (name: string, handler: Listener) =>
      listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("block selection keys", () => {
  it("removes the picked blocks with Backspace or Delete and clears the pick", () => {
    for (const name of ["Backspace", "Delete"]) {
      const selection = setup(["a", "c"]);
      const event = key(name);

      expect(selection.editor.removeBlocks).toHaveBeenCalledWith(["a", "c"]);
      expect(selection.context.picked).toEqual([]);
      expect(event.preventDefault).toHaveBeenCalled();
      selection.stop();
    }
  });

  it("copies the picked blocks as text when cutting before removing them", async () => {
    const selection = setup(["a", "missing", "c"]);

    key("x", { metaKey: true });
    await vi.waitFor(() => expect(copied).toEqual(["a\nc"]));
    expect(selection.editor.removeBlocks).toHaveBeenCalled();
  });

  it("duplicates blocks without their ids, nested children included", () => {
    const selection = setup(["a", "b"]);

    key("d", { ctrlKey: true });
    const [inserted, anchor, place] =
      selection.editor.insertBlocks.mock.calls[0];

    expect(anchor).toBe("b");
    expect(place).toBe("after");
    expect(JSON.stringify(inserted)).not.toContain('"id"');
    expect(inserted).toEqual([
      { children: [] },
      { children: [{ children: [{ children: [] }] }] },
    ]);
    expect(selection.context.picked).toEqual(["copy1", "copy2"]);
  });

  it("steps over collapsed blocks to the next visible one and stops at the ends", () => {
    dom.heights = { child: 0 };
    const selection = setup(["b"]);

    key("ArrowDown");
    expect(selection.context.picked).toEqual(["c"]);
    selection.stop();
    const top = setup(["a"]);

    key("ArrowUp");
    expect(top.setPicked).not.toHaveBeenCalled();
  });

  it("extends the pick block by block with Shift", () => {
    dom.order = ["a", "b", "c"];
    const selection = setup(["a"]);

    key("ArrowDown", { shiftKey: true });
    expect(selection.context.picked).toEqual(["a", "b"]);
    key("ArrowDown", { shiftKey: true });
    expect(selection.context.picked).toEqual(["a", "b", "c"]);
  });

  it("extends with Shift past a picked block whose children are visible", () => {
    const selection = setup(["b"]);

    key("ArrowDown", { shiftKey: true });
    expect(selection.context.picked).toEqual(["b", "c"]);
  });

  it("drops the pick when typing a character but not for shortcuts", () => {
    const selection = setup(["a"]);
    const shortcut = key("b", { metaKey: true });

    expect(selection.setPicked).not.toHaveBeenCalled();
    expect(shortcut.preventDefault).not.toHaveBeenCalled();
    const typed = key("q");

    expect(selection.context.picked).toEqual([]);
    expect(typed.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores keys while a text field or dialog has focus", () => {
    activeElement = new FakeHTMLElement(true);
    const selection = setup(["a"]);

    key("Backspace");
    key("q");
    expect(selection.editor.removeBlocks).not.toHaveBeenCalled();
    expect(selection.setPicked).not.toHaveBeenCalled();
  });

  it("clears the pick on a click outside unless Shift is held", () => {
    const selection = setup(["a"]);

    dom.selectable = false;
    listeners.get("mousedown")!({ shiftKey: true, target: {} });
    expect(selection.setPicked).not.toHaveBeenCalled();
    listeners.get("mousedown")!({ shiftKey: false, target: {} });
    expect(selection.context.picked).toEqual([]);
  });
});
