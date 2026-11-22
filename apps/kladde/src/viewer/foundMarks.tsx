import { useEffect, useRef, useState, type RefObject } from "react";
import { command } from "../platform/native";
import type { PdfSource } from "./pdfPages";

export type FoundBox = [x: number, y: number, width: number, height: number];

const MAX_BOXES = 64;
const NOTHING: FoundBox[] = [];

function isFoundBox(value: unknown): value is FoundBox {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((v) => typeof v === "number" && v >= 0 && v <= 1)
  );
}

export function foundBoxes(value: unknown): FoundBox[] {
  if (!Array.isArray(value)) return NOTHING;

  return value.filter(isFoundBox).slice(0, MAX_BOXES);
}

export function useFoundBoxes(
  { space, doc, file }: PdfSource,
  index: number,
  term: string | undefined,
) {
  const [found, setFound] = useState<{ key: string; boxes: FoundBox[] }>();
  const key = [space, doc, file, index, term].join("\n");

  useEffect(() => {
    if (!term?.trim()) return;
    let current = true;
    const request = { space, doc, file, index, term };

    command<unknown>("find_in_attachment", request)
      .then((boxes) => current && setFound({ key, boxes: foundBoxes(boxes) }))
      .catch(() => current && setFound({ key, boxes: NOTHING }));

    return () => {
      current = false;
    };
  }, [key, space, doc, file, index, term]);

  return found?.key === key ? found.boxes : NOTHING;
}

function centerOn(target: Element, stage: HTMLElement) {
  const box = target.getBoundingClientRect();
  const view = stage.getBoundingClientRect();

  stage.scrollTop += box.top + box.height / 2 - (view.top + view.height / 2);
  stage.scrollLeft += box.left + box.width / 2 - (view.left + view.width / 2);
}

export function FoundMarks({
  boxes,
  width,
  height,
  stage,
}: {
  boxes: FoundBox[];
  width: number;
  height: number;
  stage: RefObject<HTMLElement | null>;
}) {
  const first = useRef<SVGRectElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (first.current && stage.current)
        centerOn(first.current, stage.current);
    });

    return () => cancelAnimationFrame(frame);
  }, [boxes, stage]);
  if (!boxes.length) return null;

  return (
    <g className="foundmarks">
      {boxes.map(([x, y, w, h], index) => (
        <rect
          key={index}
          ref={index === 0 ? first : undefined}
          x={x * width}
          y={y * height}
          width={w * width}
          height={h * height}
        />
      ))}
    </g>
  );
}
