import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rememberView,
  restoreView,
  viewKey,
} from "../../src/workspace/viewMemory";

const SCROLL_LIMIT = 200;
const RESTORE_FRAMES = 30;

let frames: (() => void)[] = [];

function view(key: string, scrollTop = 0, maxScroll = Infinity) {
  let top = scrollTop;

  return {
    dataset: { view: key },
    isConnected: true,
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      top = Math.min(value, maxScroll);
    },
  };
}

function asElement(stub: ReturnType<typeof view>) {
  return stub as unknown as HTMLElement;
}

function runFrames() {
  let count = 0;

  while (frames.length) {
    frames.shift()!();
    count++;
  }

  return count;
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.push(callback);

    return frames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("view memory", () => {
  it("keys the workspace root apart from any page id", () => {
    expect(viewKey("page-1", "book")).toBe("page-1");
    expect(viewKey(null, "book")).toBe("root:book");
    expect(viewKey(null, "book")).not.toBe(viewKey("book", "book"));
  });

  it("restores the remembered scroll position of a view", () => {
    rememberView(asElement(view("restore-a", 340)), false);
    const target = view("restore-a");

    restoreView(asElement(target));
    expect(target.scrollTop).toBe(340);
    expect(runFrames()).toBe(0);
  });

  it("starts unknown views at the top and ignores views without a key", () => {
    const target = view("restore-unknown", 90);

    restoreView(asElement(target));
    expect(target.scrollTop).toBe(0);
    expect(() => rememberView(null, true)).not.toThrow();
    expect(() => rememberView(asElement(view("", 10)), true)).not.toThrow();
  });

  it("retries while content is still loading but gives up after a bounded number of frames", () => {
    rememberView(asElement(view("restore-growing", 5000)), false);
    const target = view("restore-growing", 0, 100);

    restoreView(asElement(target));
    expect(runFrames()).toBe(RESTORE_FRAMES - 1);
    expect(target.scrollTop).toBe(100);
  });

  it("stops retrying once the view is gone", () => {
    rememberView(asElement(view("restore-gone", 5000)), false);
    const target = view("restore-gone", 0, 100);

    target.isConnected = false;
    restoreView(asElement(target));
    expect(runFrames()).toBe(0);
  });

  it("forgets the oldest positions beyond the limit", () => {
    for (let i = 0; i <= SCROLL_LIMIT; i++)
      rememberView(asElement(view(`limit-${i}`, i + 1)), false);
    const oldest = view("limit-0", 7);
    const newest = view(`limit-${SCROLL_LIMIT}`);

    restoreView(asElement(oldest));
    restoreView(asElement(newest));
    expect(oldest.scrollTop).toBe(0);
    expect(newest.scrollTop).toBe(SCROLL_LIMIT + 1);
  });
});
