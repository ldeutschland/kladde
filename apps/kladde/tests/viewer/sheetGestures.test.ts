import { describe, expect, it } from "vitest";
import {
  gestureFor,
  marksAfter,
  movedGesture,
  type Gesture,
  type Pen,
} from "../../src/viewer/sheetGestures";
import type { Mark, Point } from "../../src/viewer/marks";

const CLIENT = { clientX: 300, clientY: 400 };
const AT: Point = [10, 20];
const PEN: Pen = { kind: "pen", color: "#191919", width: 4 };
const ARROW: Pen = { kind: "arrow", color: "#191919", width: 4 };

function mark(points: Point[], kind: Mark["kind"] = "pen"): Mark {
  return { kind, color: "#191919", width: 4, points };
}

describe("starting a gesture", () => {
  it("starts nothing for the text and crop tools or without a pen", () => {
    expect(gestureFor("text", PEN, AT, -1, CLIENT)).toBeNull();
    expect(gestureFor("crop", PEN, AT, -1, CLIENT)).toBeNull();
    expect(gestureFor(null, PEN, AT, -1, CLIENT)).toBeNull();
    expect(gestureFor("pen", undefined, AT, -1, CLIENT)).toBeNull();
  });

  it("drags a mark under the hand tool and pans the sheet elsewhere", () => {
    expect(gestureFor("hand", undefined, AT, 2, CLIENT)).toEqual({
      kind: "drag",
      index: 2,
      from: AT,
      by: [0, 0],
    });
    expect(gestureFor("hand", undefined, AT, -1, CLIENT)).toEqual({
      kind: "pan",
      x: 300,
      y: 400,
    });
  });

  it("erases the touched mark right away and nothing when none was hit", () => {
    const hit = gestureFor("eraser", undefined, AT, 3, CLIENT);
    const miss = gestureFor("eraser", undefined, AT, -1, CLIENT);

    expect(hit).toEqual({ kind: "erase", hidden: new Set([3]) });
    expect(miss).toEqual({ kind: "erase", hidden: new Set() });
  });

  it("starts two-point shapes with both ends on the start point", () => {
    const shape = gestureFor("arrow", ARROW, AT, -1, CLIENT);
    const line = gestureFor("pen", PEN, AT, -1, CLIENT);

    expect(shape).toMatchObject({ kind: "draw", mark: { points: [AT, AT] } });
    expect(line).toMatchObject({ kind: "draw", mark: { points: [AT] } });
  });
});

describe("moving and finishing a gesture", () => {
  it("adds each newly touched mark to the eraser only once", () => {
    const erase: Gesture = { kind: "erase", hidden: new Set([1]) };

    expect(movedGesture(erase, AT, () => 1)).toBeNull();
    expect(movedGesture(erase, AT, () => -1)).toBeNull();
    expect(movedGesture(erase, AT, () => 4)).toEqual({
      kind: "erase",
      hidden: new Set([1, 4]),
    });
  });

  it("skips pen points that are too close and moves the arrow tip", () => {
    const pen: Gesture = { kind: "draw", mark: mark([[0, 0]]) };
    const arrow: Gesture = {
      kind: "draw",
      mark: mark(
        [
          [0, 0],
          [0, 0],
        ],
        "arrow",
      ),
    };

    expect(movedGesture(pen, [1, 0], () => -1)).toBeNull();
    expect(movedGesture(pen, [2, 0], () => -1)).toMatchObject({
      mark: {
        points: [
          [0, 0],
          [2, 0],
        ],
      },
    });
    expect(movedGesture(arrow, [50, 5], () => -1)).toMatchObject({
      mark: {
        points: [
          [0, 0],
          [50, 5],
        ],
      },
    });
  });

  it("drops shapes shorter than their stroke width", () => {
    const tiny = mark(
      [
        [0, 0],
        [3, 0],
      ],
      "rect",
    );

    expect(marksAfter({ kind: "draw", mark: tiny }, [])).toBeNull();
  });

  it("keeps finished strokes rounded to two decimals", () => {
    const drawn = mark([
      [1.23456, 2.34567],
      [3.33333, 4.44444],
    ]);

    expect(marksAfter({ kind: "draw", mark: drawn }, [])).toEqual([
      mark([
        [1.23, 2.35],
        [3.33, 4.44],
      ]),
    ]);
  });

  it("removes erased marks and moves dragged ones, ignoring empty gestures", () => {
    const marks = [mark([[0, 0]]), mark([[5, 5]]), mark([[9, 9]])];

    expect(
      marksAfter({ kind: "erase", hidden: new Set([0, 2]) }, marks),
    ).toEqual([marks[1]]);
    expect(marksAfter({ kind: "erase", hidden: new Set() }, marks)).toBeNull();
    expect(
      marksAfter({ kind: "drag", index: 1, from: AT, by: [0, 0] }, marks),
    ).toBeNull();
    expect(
      marksAfter({ kind: "drag", index: 1, from: AT, by: [2.5, -1] }, marks),
    ).toEqual([marks[0], mark([[7.5, 4]]), marks[2]]);
    expect(marksAfter({ kind: "pan", x: 0, y: 0 }, marks)).toBeNull();
  });
});
