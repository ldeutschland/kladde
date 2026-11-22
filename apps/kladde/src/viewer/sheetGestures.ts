import {
  compact,
  extended,
  isUseful,
  moved,
  type Mark,
  type MarkKind,
  type Point,
  type Tool,
} from "./marks";

export interface Pen {
  kind: MarkKind;
  color: string;
  width: number;
}

export type Gesture =
  | { kind: "draw"; mark: Mark }
  | { kind: "erase"; hidden: Set<number> }
  | { kind: "drag"; index: number; from: Point; by: Point }
  | { kind: "pan"; x: number; y: number };

type MarkGesture = Exclude<Gesture, { kind: "pan" }>;

const DRAWING: ReadonlySet<Tool> = new Set(["pen", "marker", "arrow", "rect"]);

export function gestureFor(
  tool: Tool | null,
  pen: Pen | undefined,
  at: Point,
  index: number,
  client: { clientX: number; clientY: number },
): Gesture | null {
  if (tool === "text") return null;
  if (tool === "eraser")
    return { kind: "erase", hidden: new Set(index >= 0 ? [index] : []) };

  if (tool === "hand")
    return index >= 0
      ? { kind: "drag", index, from: at, by: [0, 0] }
      : { kind: "pan", x: client.clientX, y: client.clientY };

  if (!pen || !DRAWING.has(tool!)) return null;
  const start: Point[] =
    pen.kind === "arrow" || pen.kind === "rect" ? [at, at] : [at];

  return { kind: "draw", mark: { ...pen, points: start } };
}

export function movedGesture(
  gesture: MarkGesture,
  at: Point,
  markAt: (at: Point) => number,
): Gesture | null {
  if (gesture.kind === "erase") {
    const index = markAt(at);

    if (index < 0 || gesture.hidden.has(index)) return null;

    return { kind: "erase", hidden: new Set([...gesture.hidden, index]) };
  }

  if (gesture.kind === "drag")
    return {
      ...gesture,
      by: [at[0] - gesture.from[0], at[1] - gesture.from[1]],
    };
  const { mark } = gesture;
  const next =
    mark.kind === "pen" || mark.kind === "marker"
      ? extended(mark.points, at, mark.width)
      : [mark.points[0], at];

  if (next === mark.points) return null;

  return { kind: "draw", mark: { ...mark, points: next } };
}

export function marksAfter(finished: Gesture, marks: Mark[]) {
  if (finished.kind === "draw" && isUseful(finished.mark))
    return [...marks, compact(finished.mark)];
  if (finished.kind === "erase" && finished.hidden.size)
    return marks.filter((_, index) => !finished.hidden.has(index));
  if (finished.kind === "drag" && (finished.by[0] || finished.by[1]))
    return marks.map((mark, index) =>
      index === finished.index ? compact(moved(mark, ...finished.by)) : mark,
    );

  return null;
}
