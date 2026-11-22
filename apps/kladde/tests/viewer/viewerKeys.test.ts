import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { viewerKeys } from "../../src/viewer/viewerKeys";
import type { Zoom } from "../../src/viewer/useZoom";

let typing = false;

function setup() {
  const zoom = { zoomIn: vi.fn(), zoomOut: vi.fn(), fit: vi.fn() };
  const history = { undo: vi.fn(), redo: vi.fn() };
  const press = (
    key: string,
    extra: Record<string, unknown> = {},
    editing = true,
  ) => {
    const event = {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: vi.fn(),
      ...extra,
    };
    const handled = viewerKeys(
      event as unknown as KeyboardEvent<HTMLElement>,
      zoom as unknown as Zoom,
      editing,
      history,
    );

    return { handled, event };
  };

  return { zoom, history, press };
}

beforeEach(() => {
  typing = false;
  vi.stubGlobal("document", {
    get activeElement() {
      return { matches: () => typing };
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("viewer keys", () => {
  it("zooms with Cmd or Ctrl and the plus, minus and zero keys", () => {
    const { zoom, press } = setup();

    expect(press("=", { metaKey: true }).handled).toBe(true);
    press("+", { ctrlKey: true });
    press("-", { metaKey: true });
    const fit = press("0", { ctrlKey: true });

    expect(zoom.zoomIn).toHaveBeenCalledTimes(2);
    expect(zoom.zoomOut).toHaveBeenCalledOnce();
    expect(zoom.fit).toHaveBeenCalledOnce();
    expect(fit.event.preventDefault).toHaveBeenCalled();
  });

  it("leaves keys without a modifier to the page", () => {
    const { zoom, history, press } = setup();
    const plain = press("=");

    press("z");
    expect(plain.handled).toBe(false);
    expect(plain.event.preventDefault).not.toHaveBeenCalled();
    expect(zoom.zoomIn).not.toHaveBeenCalled();
    expect(history.undo).not.toHaveBeenCalled();
  });

  it("undoes and redoes only while editing", () => {
    const { history, press } = setup();

    press("z", { metaKey: true });
    press("Z", { metaKey: true, shiftKey: true });
    expect(history.undo).toHaveBeenCalledOnce();
    expect(history.redo).toHaveBeenCalledOnce();
    expect(press("z", { metaKey: true }, false).handled).toBe(false);
    expect(history.undo).toHaveBeenCalledOnce();
  });

  it("stays out of the way while typing or composing text", () => {
    const { zoom, press } = setup();

    expect(
      press("=", { metaKey: true, nativeEvent: { isComposing: true } }).handled,
    ).toBe(false);
    typing = true;
    expect(press("=", { metaKey: true }).handled).toBe(false);
    expect(zoom.zoomIn).not.toHaveBeenCalled();
  });
});
