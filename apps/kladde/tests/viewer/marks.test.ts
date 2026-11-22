import { describe, expect, it } from "vitest";
import {
  apply,
  arrowHead,
  compact,
  extended,
  flipped,
  hits,
  invert,
  isUseful,
  mapBox,
  resizedBox,
  rotated,
  sheetMatrix,
  compose,
  turnedSize,
  type Mark,
  type Point,
  type Turn,
} from "../../src/viewer/marks";
import {
  outputScale,
  outputType,
  visibleBox,
  MAX_PIXELS,
} from "../../src/viewer/imageExport";
import { savedName } from "../../src/viewer/viewing";
import { translator } from "../../src/locale/locale";

const WIDTH = 400,
  HEIGHT = 200;

function close(actual: Point, expected: Point) {
  expect(actual[0]).toBeCloseTo(expected[0]);
  expect(actual[1]).toBeCloseTo(expected[1]);
}

function pen(points: Point[], width = 4): Mark {
  return { kind: "pen", color: "#191919", width, points };
}

describe("sheet geometry", () => {
  it("turns the top-left corner clockwise", () => {
    const corner = (turn: Turn) =>
      apply(sheetMatrix(WIDTH, HEIGHT, turn), [0, 0]);

    close(corner(0), [0, 0]);
    close(corner(90), [HEIGHT, 0]);
    close(corner(180), [WIDTH, HEIGHT]);
    close(corner(270), [0, WIDTH]);
    expect(turnedSize(WIDTH, HEIGHT, 90)).toEqual([HEIGHT, WIDTH]);
  });

  it("maps back with the inverse", () => {
    const m = sheetMatrix(WIDTH, HEIGHT, 270, true);

    close(apply(compose(m, invert(m)), [37, 81]), [37, 81]);
  });

  it("mirrors along the screen whatever the turn", () => {
    for (const turn of [0, 90, 180, 270] as Turn[]) {
      const [shownWidth] = turnedSize(WIDTH, HEIGHT, turn);
      const before = sheetMatrix(WIDTH, HEIGHT, turn, false);
      const next = flipped(turn, false);
      const after = sheetMatrix(WIDTH, HEIGHT, next.turn, next.flip);
      const [x, y] = apply(before, [30, 50]);

      close(apply(after, [30, 50]), [shownWidth - x, y]);
    }
  });

  it("keeps turns within a full circle", () => {
    expect(rotated(0, -90)).toBe(270);
    expect(rotated(270, 90)).toBe(0);
  });

  it("maps boxes through turns", () => {
    const box = mapBox(sheetMatrix(WIDTH, HEIGHT, 90), {
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });

    expect(box).toEqual({ x: 130, y: 10, width: 50, height: 100 });
  });
});

describe("crop frame", () => {
  const bounds = { x: 0, y: 0, width: 100, height: 80 };
  const frame = { x: 10, y: 10, width: 50, height: 40 };

  it("moves inside the bounds", () => {
    expect(resizedBox(frame, "move", [100, -100], bounds, 5)).toEqual({
      ...frame,
      x: 50,
      y: 0,
    });
  });

  it("resizes edges but keeps a smallest size", () => {
    expect(resizedBox(frame, "nw", [-20, 5], bounds, 5)).toEqual({
      x: 0,
      y: 15,
      width: 60,
      height: 35,
    });
    expect(resizedBox(frame, "e", [-100, 0], bounds, 5).width).toBe(5);
  });
});

describe("marks", () => {
  const upright = sheetMatrix(WIDTH, HEIGHT, 0);

  it("finds strokes near the line and not far away", () => {
    const line = pen([
      [0, 0],
      [100, 0],
    ]);

    expect(hits(line, [50, 3], upright, 1)).toBe(true);
    expect(hits(line, [50, 30], upright, 1)).toBe(false);
  });

  it("finds rectangles on the outline only", () => {
    const frame: Mark = {
      kind: "rect",
      color: "#e03e3e",
      width: 2,
      points: [
        [0, 0],
        [100, 100],
      ],
    };

    expect(hits(frame, [100, 50], upright, 0)).toBe(true);
    expect(hits(frame, [50, 50], upright, 0)).toBe(false);
  });

  it("finds text in the upright box after a turn", () => {
    const note: Mark = {
      kind: "text",
      color: "#191919",
      width: 20,
      points: [[100, 100]],
      text: "Hallo",
    };
    const turned = sheetMatrix(WIDTH, HEIGHT, 90);

    expect(hits(note, [100, 70], turned, 0)).toBe(true);
    expect(hits(note, [100, 130], turned, 0)).toBe(false);
  });

  it("skips points closer than a fraction of the width", () => {
    const start: Point[] = [[0, 0]];

    expect(extended(start, [0.5, 0], 4)).toBe(start);
    expect(extended(start, [5, 0], 4)).toHaveLength(2);
  });

  it("drops shapes that are too small and empty text", () => {
    const arrow: Mark = {
      kind: "arrow",
      color: "#e03e3e",
      width: 4,
      points: [
        [0, 0],
        [1, 1],
      ],
    };

    expect(isUseful(arrow)).toBe(false);
    expect(
      isUseful({
        ...arrow,
        points: [
          [0, 0],
          [20, 0],
        ],
      }),
    ).toBe(true);
    expect(
      isUseful({ ...arrow, kind: "text", points: [[0, 0]], text: " " }),
    ).toBe(false);
  });

  it("draws the arrow head back from the tip", () => {
    const [wing, tip, other] = arrowHead({
      kind: "arrow",
      color: "#e03e3e",
      width: 2,
      points: [
        [0, 0],
        [100, 0],
      ],
    });

    expect(tip).toEqual([100, 0]);
    expect(wing[0]).toBeLessThan(100);
    expect(wing[1]).toBeCloseTo(-other[1]);
  });

  it("rounds coordinates before they are stored", () => {
    expect(compact(pen([[1.23456, 2.34567]], 3.14159))).toEqual(
      pen([[1.23, 2.35]], 3.14),
    );
  });
});

describe("image output", () => {
  it("shows the cropped area in turned coordinates", () => {
    const box = visibleBox(WIDTH, HEIGHT, {
      turn: 90,
      flip: false,
      crop: { x: 0, y: 0, width: 100, height: 50 },
      marks: [],
    });

    expect(box).toEqual({ x: 150, y: 0, width: 50, height: 100 });
  });

  it("limits the pixels of large images", () => {
    const box = { x: 0, y: 0, width: 8000, height: 6000 };
    const scale = outputScale(box);

    expect(box.width * box.height * scale * scale).toBeLessThanOrEqual(
      MAX_PIXELS + 1,
    );
    expect(outputScale({ x: 0, y: 0, width: 100, height: 100 })).toBe(1);
  });

  it("keeps common image types and falls back to PNG", () => {
    expect(outputType("image/jpeg")).toBe("image/jpeg");
    expect(outputType("image/gif")).toBe("image/png");
  });
});

describe("saved names", () => {
  const t = translator("de");

  it("keeps the name for a replaced file", () => {
    expect(savedName("Foto.JPG", "image/jpeg", false, t)).toBe("Foto.JPG");
    expect(savedName("Vertrag.pdf", "application/pdf", false, t)).toBe(
      "Vertrag.pdf",
    );
  });

  it("marks copies and follows a changed type", () => {
    expect(savedName("Animation.gif", "image/png", true, t)).toBe(
      "Animation (bearbeitet).png",
    );
    expect(savedName("", "application/pdf", true, t)).toBe(
      "Datei (bearbeitet).pdf",
    );
  });
});
