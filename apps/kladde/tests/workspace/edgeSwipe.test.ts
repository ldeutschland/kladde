import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followEdgeSwipe } from "../../src/workspace/edgeSwipe";

const EDGE = 24;
const WIDTH = 400;
const COMMIT_SHARE = 0.4;

type Handler = (event: unknown) => void;

let handlers: Map<string, Handler>;

function surfaceStub() {
  return {
    clientWidth: WIDTH,
    isConnected: true,
    style: { transform: "", transition: "" },
    attributes: new Set<string>(),
    setAttribute(name: string) {
      this.attributes.add(name);
    },
    removeAttribute(name: string) {
      this.attributes.delete(name);
    },
  };
}

function touch(x: number, y = 100) {
  return { clientX: x, clientY: y };
}

function setup(enabled = true) {
  const surface = surfaceStub();
  const layer = { remove: vi.fn() };
  const back = vi.fn();
  const stop = followEdgeSwipe({
    surface: () => surface as unknown as HTMLElement,
    underlay: () => layer as unknown as HTMLElement,
    enabled: () => enabled,
    back,
  });
  const preventDefault = vi.fn();
  const fire = (name: string, event: Record<string, unknown>) =>
    handlers.get(name)!({ target: null, preventDefault, ...event });
  const start = (x: number, y = 100, fingers = 1) =>
    fire("touchstart", {
      touches: Array.from({ length: fingers }, () => touch(x, y)),
      timeStamp: 0,
    });
  const move = (x: number, y = 100, timeStamp = 50) =>
    fire("touchmove", { touches: [touch(x, y)], timeStamp });
  const end = (x: number, timeStamp = 1000) =>
    fire("touchend", { changedTouches: [touch(x)], timeStamp });

  return { surface, layer, back, stop, start, move, end, preventDefault };
}

beforeEach(() => {
  vi.useFakeTimers();
  handlers = new Map();
  vi.stubGlobal("Element", class {});
  vi.stubGlobal("document", {
    body: {},
    addEventListener: (name: string, handler: Handler) =>
      handlers.set(name, handler),
    removeEventListener: (name: string) => handlers.delete(name),
  });
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: true }),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) =>
    setTimeout(fn, 16),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("edge swipe back", () => {
  it("goes back after dragging past the commit share of the width", () => {
    const swipe = setup();
    const across = WIDTH * COMMIT_SHARE + 1;

    swipe.start(EDGE);
    swipe.move(EDGE + 20);
    expect(swipe.preventDefault).toHaveBeenCalled();
    expect(swipe.surface.style.transform).toBe("translate3d(20px, 0, 0)");
    swipe.end(EDGE + across);
    expect(swipe.back).toHaveBeenCalledOnce();
  });

  it("slides back without navigating after a short slow drag", () => {
    const swipe = setup();

    swipe.start(10);
    swipe.move(10 + WIDTH * COMMIT_SHARE - 1, 100, 50);
    swipe.end(10 + WIDTH * COMMIT_SHARE - 1, 5000);
    expect(swipe.back).not.toHaveBeenCalled();
    expect(swipe.surface.style.transform).toBe("");
    expect(swipe.layer.remove).toHaveBeenCalled();
    expect(swipe.surface.attributes.has("data-swiping")).toBe(false);
  });

  it("goes back after a quick flick even when the distance is short", () => {
    const swipe = setup();

    swipe.start(5);
    swipe.move(40, 100, 100);
    swipe.end(80, 150);
    expect(swipe.back).toHaveBeenCalledOnce();
  });

  it("ignores touches that start away from the edge, with two fingers or while disabled", () => {
    const away = setup();

    away.start(EDGE + 1);
    away.move(EDGE + 300);
    away.end(EDGE + 300);
    away.stop();
    const pinch = setup();

    pinch.start(5, 100, 2);
    pinch.move(300);
    pinch.end(300);
    pinch.stop();
    const disabled = setup(false);

    disabled.start(5);
    disabled.move(300);
    disabled.end(300);

    for (const swipe of [away, pinch, disabled]) {
      expect(swipe.back).not.toHaveBeenCalled();
      expect(swipe.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("lets vertical scrolling win when the finger first moves up or down", () => {
    const swipe = setup();

    swipe.start(5, 100);
    swipe.move(10, 140);
    swipe.move(300, 140);
    swipe.end(300);
    expect(swipe.preventDefault).not.toHaveBeenCalled();
    expect(swipe.back).not.toHaveBeenCalled();
  });

  it("removes the revealed page once the swiped page has left", () => {
    const swipe = setup();

    swipe.start(5);
    swipe.move(300);
    swipe.surface.isConnected = false;
    swipe.end(300);
    expect(swipe.layer.remove).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(swipe.layer.remove).toHaveBeenCalled();
  });
});
