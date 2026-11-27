import { useEffect, useRef, useState, type RefObject } from "react";
import { command } from "../platform/native";
import type { PdfSource } from "./pdfPages";

export type FoundBox = [x: number, y: number, width: number, height: number];

export interface PageMarks {
  boxes: FoundBox[];
  current: FoundBox[];
}

export interface FoundView {
  marks: PageMarks;
  centered: boolean;
}

const MAX_BOXES = 64;
const NOTHING: FoundBox[] = [];
const NO_MARKS: PageMarks = { boxes: NOTHING, current: NOTHING };

function isFoundBox(value: unknown): value is FoundBox {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((v) => typeof v === "number" && v >= 0 && v <= 1)
  );
}

export function foundBoxes(value: unknown, limit = MAX_BOXES): FoundBox[] {
  if (!Array.isArray(value)) return NOTHING;

  return value.filter(isFoundBox).slice(0, limit);
}

export function useFoundMarks(
  { space, doc, file }: PdfSource,
  index: number,
  term: string | undefined,
) {
  const [found, setFound] = useState<{ key: string; marks: PageMarks }>();
  const key = [space, doc, file, index, term].join("\n");

  useEffect(() => {
    if (!term?.trim()) return;
    let current = true;
    const request = { space, doc, file, index, term };
    const keep = (boxes: FoundBox[]) => {
      if (current) setFound({ key, marks: { boxes, current: NOTHING } });
    };

    command<unknown>("find_in_attachment", request)
      .then((boxes) => keep(foundBoxes(boxes)))
      .catch(() => keep(NOTHING));

    return () => {
      current = false;
    };
  }, [key, space, doc, file, index, term]);

  return found?.key === key ? found.marks : NO_MARKS;
}

function centerOn(target: Element, stage: HTMLElement) {
  const box = target.getBoundingClientRect();
  const view = stage.getBoundingClientRect();

  stage.scrollTop += box.top + box.height / 2 - (view.top + view.height / 2);
  stage.scrollLeft += box.left + box.width / 2 - (view.left + view.width / 2);
}

function MarkRects({
  boxes,
  width,
  height,
  className,
  first,
}: {
  boxes: FoundBox[];
  width: number;
  height: number;
  className?: string;
  first?: RefObject<SVGRectElement | null>;
}) {
  return boxes.map(([x, y, w, h], index) => (
    <rect
      key={index}
      ref={index === 0 ? first : undefined}
      className={className}
      x={x * width}
      y={y * height}
      width={w * width}
      height={h * height}
    />
  ));
}

export function FoundMarks({
  found,
  width,
  height,
  stage,
}: {
  found: FoundView;
  width: number;
  height: number;
  stage: RefObject<HTMLElement | null>;
}) {
  const first = useRef<SVGRectElement>(null);
  const { marks, centered } = found;
  const focused = marks.current.length ? "current" : "boxes";

  useEffect(() => {
    if (!centered) return;
    const frame = requestAnimationFrame(() => {
      if (first.current && stage.current)
        centerOn(first.current, stage.current);
    });

    return () => cancelAnimationFrame(frame);
  }, [marks, centered, stage]);
  if (!marks.boxes.length && !marks.current.length) return null;

  return (
    <g className="foundmarks">
      <MarkRects
        boxes={marks.boxes}
        width={width}
        height={height}
        first={focused === "boxes" ? first : undefined}
      />
      <MarkRects
        boxes={marks.current}
        width={width}
        height={height}
        className="current"
        first={focused === "current" ? first : undefined}
      />
    </g>
  );
}
