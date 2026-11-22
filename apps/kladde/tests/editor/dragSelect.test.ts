import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Area } from "../../src/editor/selectionDom";

const dom = vi.hoisted(() => ({
  hits: [] as string[],
  between: [] as [number, number][],
  selectable: true,
}));

vi.mock("../../src/editor/selectionDom", () => ({
  blocksBetween: (_root: unknown, top: number, bottom: number) => {
    dom.between.push([top, bottom]);

    return dom.hits;
  },
  blurActive: () => {},
  startsSelection: () => dom.selectable,
}));

const { listenForDragSelect } = await import("../../src/editor/dragSelect");

type Listener = (event: unknown) => void;

let windowListeners: Map<string, Listener[]>;

function emit(name: string, event: unknown) {
  for (const listener of windowListeners.get(name) ?? []) listener(event);
}

function setup(picked: string[] = []) {
  let down: Listener | undefined;
  const scroller = {
    scrollTop: 0,
    addEventListener: (_name: string, listener: Listener) => (down = listener),
    removeEventListener: () => (down = undefined),
    getBoundingClientRect: () => ({ top: 0, bottom: 1000 }),
  };
  const state = {
    picked,
    boxes: [] as (Area | null)[],
  };
  const stop = listenForDragSelect({
    root: {} as HTMLElement,
    scroller: scroller as unknown as HTMLElement,
    picked: () => state.picked,
    setPicked: (ids) => (state.picked = ids),
    setBox: (box) => state.boxes.push(box),
  });
  const press = (x: number, y: number, extra = {}) =>
    down!({
      button: 0,
      clientX: x,
      clientY: y,
      shiftKey: false,
      target: {},
      preventDefault: vi.fn(),
      ...extra,
    });
  const move = (x: number, y: number) =>
    emit("mousemove", { clientX: x, clientY: y });

  return { state, scroller, stop, press, move };
}

beforeEach(() => {
  vi.useFakeTimers();
  windowListeners = new Map();
  dom.hits = ["a", "b"];
  dom.between = [];
  dom.selectable = true;
  vi.stubGlobal("window", {
    addEventListener: (name: string, listener: Listener) =>
      windowListeners.set(name, [
        ...(windowListeners.get(name) ?? []),
        listener,
      ]),
    removeEventListener: (name: string, listener: Listener) =>
      windowListeners.set(
        name,
        (windowListeners.get(name) ?? []).filter((item) => item !== listener),
      ),
  });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("drag selection", () => {
  it("waits for the pointer to travel the drag threshold before selecting", () => {
    const drag = setup(["old"]);

    drag.press(100, 100);
    expect(drag.state.picked).toEqual([]);
    drag.move(102, 102);
    expect(drag.state.boxes).toEqual([]);
    drag.move(103, 103);
    expect(drag.state.picked).toEqual(["a", "b"]);
  });

  it("draws a normalised box when dragging up and to the left", () => {
    const drag = setup();

    drag.press(200, 300);
    drag.move(150, 120);
    expect(drag.state.boxes.at(-1)).toEqual({
      top: 120,
      left: 150,
      width: 50,
      height: 180,
    });
    expect(dom.between.at(-1)).toEqual([120, 300]);
  });

  it("keeps the start point anchored to the content while the page scrolls", () => {
    const drag = setup();

    drag.press(100, 300);
    drag.scroller.scrollTop = 100;
    drag.move(100, 400);
    expect(drag.state.boxes.at(-1)).toMatchObject({ top: 200, height: 200 });
  });

  it("adds to the existing pick without duplicates when Shift is held", () => {
    const drag = setup(["b", "z"]);

    drag.press(0, 0, { shiftKey: true });
    drag.move(0, 50);
    expect(drag.state.picked).toEqual(["b", "z", "a"]);
  });

  it("ignores other mouse buttons and presses on controls", () => {
    const drag = setup(["keep"]);

    drag.press(0, 0, { button: 2 });
    dom.selectable = false;
    drag.press(0, 0);
    expect(drag.state.picked).toEqual(["keep"]);
    expect(windowListeners.get("mousemove") ?? []).toEqual([]);
  });

  it("swallows the click that ends a real drag but not a plain click", () => {
    const click = setup();

    click.press(0, 0);
    emit("mouseup", {});
    expect(windowListeners.get("click") ?? []).toEqual([]);
    expect(click.state.boxes).toEqual([null]);
    const drag = setup();

    drag.press(0, 0);
    drag.move(0, 40);
    emit("mouseup", {});
    expect(windowListeners.get("click")).toHaveLength(1);
    expect(windowListeners.get("mousemove")).toEqual([]);
  });
});
