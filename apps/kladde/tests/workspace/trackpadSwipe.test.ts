import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  followTrackpadSwipe,
  type Direction,
} from "../../src/workspace/trackpadSwipe";

const TRIGGER = 140;
const QUIET_MS = 220;

class FakeNode {}

interface Hint {
  dataset: Record<string, string>;
  style: { opacity: string; setProperty: () => void };
  remove: () => void;
}

let wheel: ((event: unknown) => void) | undefined;
let hint: Hint;

function setup(can: (direction: Direction) => boolean = () => true) {
  const inside = new FakeNode();
  const go = vi.fn();
  const area = { contains: (node: unknown) => node === inside };
  const stop = followTrackpadSwipe({
    area: () => area as unknown as HTMLElement,
    can,
    go,
  });
  const scroll = (deltaX: number, deltaY = 0, extra = {}) =>
    wheel!({ target: inside, deltaX, deltaY, ctrlKey: false, ...extra });

  return { go, stop, scroll, inside };
}

beforeEach(() => {
  vi.useFakeTimers();
  wheel = undefined;
  hint = {
    dataset: {},
    style: { opacity: "", setProperty: () => {} },
    remove: vi.fn(),
  };
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("Element", class {});
  vi.stubGlobal("document", {
    createElement: () => ({ ...hint, setAttribute: () => {} }),
    body: { append: (created: Hint) => (hint = created) },
  });
  vi.stubGlobal("window", {
    addEventListener: (name: string, handler: (event: unknown) => void) => {
      if (name === "wheel") wheel = handler;
    },
    removeEventListener: (name: string) => {
      if (name === "wheel") wheel = undefined;
    },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("trackpad swipe", () => {
  it("navigates once the sideways travel reaches the trigger distance", () => {
    const { go, scroll } = setup();

    scroll(-(TRIGGER - 1));
    expect(go).not.toHaveBeenCalled();
    expect(Number(hint.style.opacity)).toBeCloseTo((TRIGGER - 1) / TRIGGER);
    scroll(-1);
    expect(go.mock.calls).toEqual([[-1]]);
    expect(hint.style.opacity).toBe("0");
  });

  it("navigates only once per gesture until the wheel goes quiet", () => {
    const { go, scroll } = setup();

    scroll(-TRIGGER);
    scroll(-TRIGGER);
    vi.advanceTimersByTime(QUIET_MS - 1);
    scroll(-TRIGGER);
    expect(go).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(QUIET_MS);
    scroll(-TRIGGER);
    expect(go).toHaveBeenCalledTimes(2);
  });

  it("follows the finger direction, including natural scrolling turned off", () => {
    const { go, scroll } = setup();

    scroll(TRIGGER);
    vi.advanceTimersByTime(QUIET_MS);
    scroll(TRIGGER, 0, { webkitDirectionInvertedFromDevice: false });
    expect(go.mock.calls).toEqual([[1], [-1]]);
  });

  it("ignores gestures that start mostly vertical, even if they turn sideways later", () => {
    const { go, scroll } = setup();

    scroll(5, 10);
    scroll(TRIGGER * 2);
    expect(go).not.toHaveBeenCalled();
  });

  it("requires the sideways part to be more than twice the vertical part", () => {
    const { go, scroll } = setup();

    scroll(-10, 5);
    scroll(-TRIGGER);
    expect(go).not.toHaveBeenCalled();
  });

  it("ignores pinch zoom, events outside the area and directions that cannot go further", () => {
    const blocked = setup(() => false);

    blocked.scroll(-TRIGGER * 2);
    expect(blocked.go).not.toHaveBeenCalled();
    blocked.stop();
    const { go, scroll } = setup();

    scroll(-TRIGGER * 2, 0, { ctrlKey: true });
    scroll(-TRIGGER * 2, 0, { target: new FakeNode() });
    expect(go).not.toHaveBeenCalled();
  });

  it("removes its listener and hint when stopped", () => {
    const { stop } = setup();

    stop();
    expect(wheel).toBeUndefined();
    expect(hint.remove).toHaveBeenCalled();
  });
});
