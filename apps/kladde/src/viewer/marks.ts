export type Point = [number, number];
export type Matrix = [number, number, number, number, number, number];
export type Turn = 0 | 90 | 180 | 270;
export type MarkKind = "pen" | "marker" | "arrow" | "rect" | "text";
export type Tool = MarkKind | "hand" | "eraser" | "crop";

export interface Mark {
  kind: MarkKind;
  color: string;
  width: number;
  points: Point[];
  text?: string;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const COLORS = [
  "#191919",
  "#e03e3e",
  "#d9730d",
  "#ffd400",
  "#0f7b6c",
  "#2383e2",
  "#9065b0",
] as const;
export const STARTING_COLORS: Record<MarkKind, string> = {
  pen: COLORS[0],
  marker: COLORS[3],
  arrow: COLORS[1],
  rect: COLORS[1],
  text: COLORS[0],
};
export const SIZES: Record<MarkKind, readonly [number, number, number]> = {
  pen: [1.5, 3, 6],
  marker: [10, 16, 26],
  arrow: [2, 3.5, 6],
  rect: [2, 3.5, 6],
  text: [14, 20, 32],
};
export const MARKER_OPACITY = 0.35;
export const TEXT_FONT = "Helvetica, Arial, sans-serif";
export const TEXT_INSET = 0.1;
export const TEXT_BASELINE = 0.88;
export const TEXT_LINE = 1.05;
const TEXT_ADVANCE = 0.56;
const ARROW_LENGTH = 4;
const ARROW_ANGLE = (25 * Math.PI) / 180;
const SIZE_UNIT = 1000;
const GRAB_TOLERANCE = 6;
const MIN_STEP = 0.35;
const DECIMALS = 100;

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function apply(m: Matrix, [x, y]: Point): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function compose(first: Matrix, second: Matrix): Matrix {
  const [a, b, c, d, e, f] = first;
  const [x0, y0] = apply(second, [e, f]);

  return [
    second[0] * a + second[2] * b,
    second[1] * a + second[3] * b,
    second[0] * c + second[2] * d,
    second[1] * c + second[3] * d,
    x0,
    y0,
  ];
}

export function invert([a, b, c, d, e, f]: Matrix): Matrix {
  const det = a * d - b * c;

  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

export function linear([a, b, c, d]: Matrix): Matrix {
  return [a, b, c, d, 0, 0];
}

export function turnedSize(width: number, height: number, turn: Turn): Point {
  return turn % 180 ? [height, width] : [width, height];
}

export function rotated(turn: Turn, by: 90 | -90): Turn {
  return ((((turn + by) % 360) + 360) % 360) as Turn;
}

function turnOnly(width: number, height: number, turn: Turn): Matrix {
  if (turn === 90) return [0, 1, -1, 0, height, 0];
  if (turn === 180) return [-1, 0, 0, -1, width, height];
  if (turn === 270) return [0, -1, 1, 0, 0, width];

  return IDENTITY;
}

export function sheetMatrix(
  width: number,
  height: number,
  turn: Turn,
  flip = false,
): Matrix {
  const mirror: Matrix = flip ? [-1, 0, 0, 1, width, 0] : IDENTITY;

  return compose(mirror, turnOnly(width, height, turn));
}

export function boxOf(points: Point[]): Box {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x = Math.min(...xs),
    y = Math.min(...ys);

  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function corners({ x, y, width, height }: Box): Point[] {
  return [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ];
}

export function mapBox(m: Matrix, box: Box): Box {
  return boxOf(corners(box).map((point) => apply(m, point)));
}

export function sizeUnit(width: number, height: number) {
  return Math.max(width, height) / SIZE_UNIT;
}

export function strokeWidth(
  kind: MarkKind,
  size: number,
  width: number,
  height: number,
) {
  return SIZES[kind][size] * sizeUnit(width, height);
}

export function arrowHead(mark: Mark): Point[] {
  const [[x0, y0], [x1, y1]] = mark.points;
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const length = mark.width * ARROW_LENGTH;
  const wing = (side: number): Point => [
    x1 - length * Math.cos(angle + side * ARROW_ANGLE),
    y1 - length * Math.sin(angle + side * ARROW_ANGLE),
  ];

  return [wing(1), [x1, y1], wing(-1)];
}

export function textLines(mark: Mark) {
  return (mark.text ?? "").split("\n");
}

export function textSize(mark: Mark): Point {
  const lines = textLines(mark);
  const longest = Math.max(...lines.map((line) => line.length));

  return [
    mark.width * (longest * TEXT_ADVANCE + 2 * TEXT_INSET),
    mark.width * (TEXT_BASELINE + (lines.length - 1) * TEXT_LINE + 0.3),
  ];
}

function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length
    ? Math.max(
        0,
        Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length),
      )
    : 0;

  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function lineHits(points: Point[], p: Point, reach: number) {
  if (points.length === 1)
    return Math.hypot(p[0] - points[0][0], p[1] - points[0][1]) <= reach;

  return points.some(
    (point, i) => i > 0 && segmentDistance(p, points[i - 1], point) <= reach,
  );
}

export function hits(mark: Mark, p: Point, upright: Matrix, slack: number) {
  const reach = mark.width / 2 + slack * GRAB_TOLERANCE;

  if (mark.kind === "text") {
    const [dx, dy] = apply(linear(upright), [
      p[0] - mark.points[0][0],
      p[1] - mark.points[0][1],
    ]);
    const [width, height] = textSize(mark);

    return (
      dx >= -reach &&
      dy >= -reach &&
      dx <= width + reach &&
      dy <= height + reach
    );
  }

  if (mark.kind !== "rect") return lineHits(mark.points, p, reach);
  const outline = corners(boxOf(mark.points));

  return lineHits([...outline, outline[0]], p, reach);
}

export function flipped(turn: Turn, flip: boolean) {
  return { turn: ((360 - turn) % 360) as Turn, flip: !flip };
}

export function moved(mark: Mark, dx: number, dy: number): Mark {
  return {
    ...mark,
    points: mark.points.map(([x, y]) => [x + dx, y + dy]),
  };
}

export function extended(points: Point[], next: Point, width: number) {
  const last = points[points.length - 1];

  if (
    last &&
    Math.hypot(next[0] - last[0], next[1] - last[1]) < width * MIN_STEP
  )
    return points;

  return [...points, next];
}

function rounded(value: number) {
  return Math.round(value * DECIMALS) / DECIMALS;
}

export function compact(mark: Mark): Mark {
  return {
    ...mark,
    width: rounded(mark.width),
    points: mark.points.map(([x, y]) => [rounded(x), rounded(y)]),
  };
}

export function isUseful(mark: Mark) {
  if (mark.kind === "text") return !!mark.text?.trim();
  if (mark.kind === "pen" || mark.kind === "marker")
    return mark.points.length > 0;
  const [[x0, y0], [x1, y1]] = mark.points;

  return Math.hypot(x1 - x0, y1 - y0) >= mark.width;
}

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value));
}

export function resizedBox(
  from: Box,
  edges: string,
  [dx, dy]: Point,
  bounds: Box,
  least: number,
): Box {
  const right = bounds.x + bounds.width,
    bottom = bounds.y + bounds.height;

  if (edges === "move")
    return {
      ...from,
      x: clamp(from.x + dx, bounds.x, right - from.width),
      y: clamp(from.y + dy, bounds.y, bottom - from.height),
    };
  let left = from.x,
    top = from.y,
    end = from.x + from.width,
    foot = from.y + from.height;

  if (edges.includes("w")) left = clamp(left + dx, bounds.x, end - least);
  if (edges.includes("e")) end = clamp(end + dx, left + least, right);
  if (edges.includes("n")) top = clamp(top + dy, bounds.y, foot - least);
  if (edges.includes("s")) foot = clamp(foot + dy, top + least, bottom);

  return { x: left, y: top, width: end - left, height: foot - top };
}
