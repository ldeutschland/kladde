import {
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { hits, type Mark, type Matrix, type Point, type Tool } from "./marks";
import {
  gestureFor,
  marksAfter,
  movedGesture,
  type Gesture,
  type Pen,
} from "./sheetGestures";
import type { SheetTyping } from "./useSheetTyping";

const PAN_AREA = ".viewerstage";

interface GestureOptions {
  group: RefObject<SVGGElement | null>;
  marks: Mark[];
  upright: Matrix;
  scale: number;
  tool: Tool | null;
  pen?: Pen;
  change?: (marks: Mark[]) => void;
  active: boolean;
  typing: SheetTyping;
}

function sourcePoint(
  group: SVGGElement | null,
  event: { clientX: number; clientY: number },
): Point {
  const matrix = group?.getScreenCTM();

  if (!matrix) return [0, 0];
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
    matrix.inverse(),
  );

  return [point.x, point.y];
}

export function useSheetGestures(options: GestureOptions) {
  const { marks, tool, typing } = options;
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const skipUp = useRef(false);
  const pointOf = (event: { clientX: number; clientY: number }) =>
    sourcePoint(options.group.current, event);

  function markAt(at: Point) {
    for (let index = marks.length - 1; index >= 0; index--)
      if (hits(marks[index], at, options.upright, 1 / options.scale))
        return index;

    return -1;
  }

  function down(event: PointerEvent<SVGSVGElement>) {
    if (!options.active || event.button > 0) return;

    if (typing.typing) {
      skipUp.current = true;

      return;
    }

    const at = pointOf(event);
    const index = markAt(at);

    if (tool === "hand" && index < 0 && event.pointerType === "touch") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = gestureFor(tool, options.pen, at, index, event);

    if (next) setGesture(next);
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    if (!gesture) return;

    if (gesture.kind === "pan") {
      event.currentTarget
        .closest(PAN_AREA)
        ?.scrollBy(gesture.x - event.clientX, gesture.y - event.clientY);
      setGesture({ kind: "pan", x: event.clientX, y: event.clientY });

      return;
    }

    const next = movedGesture(gesture, pointOf(event), markAt);

    if (next) setGesture(next);
  }

  function startTypingAt(event: PointerEvent<SVGSVGElement>) {
    const at = pointOf(event);
    const index = markAt(at);

    typing.start(at, index >= 0 && marks[index].kind === "text" ? index : -1);
  }

  function up(event: PointerEvent<SVGSVGElement>) {
    const finished = gesture;

    setGesture(null);

    if (skipUp.current) {
      skipUp.current = false;

      return;
    }

    if (!options.change) return;
    const pointerUp = event.type === "pointerup";

    if (tool === "text" && options.active && !typing.typing && pointerUp) {
      startTypingAt(event);

      return;
    }

    if (!finished || !pointerUp) return;
    const next = marksAfter(finished, marks);

    if (next) options.change(next);
  }

  function doubleClick(event: MouseEvent<SVGSVGElement>) {
    if (!options.active || tool !== "hand") return;
    const index = markAt(pointOf(event));

    if (index >= 0 && marks[index].kind === "text")
      typing.start(marks[index].points[0], index);
  }

  return { gesture, down, move, up, doubleClick };
}
