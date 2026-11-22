import { useRef, type PointerEvent } from "react";
import { Check } from "lucide-react";
import { corners, resizedBox, type Box, type Point } from "./marks";
import type { T } from "../locale/locale";

const HANDLE_PX = 14;
const SMALLEST_CROP = 0.02;
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

function handleAt(edges: string, { x, y, width, height }: Box): Point {
  const column = edges.includes("w") ? 0 : edges.includes("e") ? 1 : 0.5;
  const row = edges.includes("n") ? 0 : edges.includes("s") ? 1 : 0.5;

  return [x + width * column, y + height * row];
}

export function CropFrame({
  frame,
  bounds,
  scale,
  change,
}: {
  frame: Box;
  bounds: Box;
  scale: number;
  change: (frame: Box) => void;
}) {
  const drag = useRef<{ edges: string; start: Point; from: Box } | null>(null);

  function svgPoint(event: PointerEvent<SVGElement>): Point {
    const matrix = event.currentTarget.ownerSVGElement?.getScreenCTM();

    if (!matrix) return [0, 0];
    const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix.inverse(),
    );

    return [local.x, local.y];
  }

  const grab = (edges: string) => (event: PointerEvent<SVGElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { edges, start: svgPoint(event), from: frame };
  };

  function move(event: PointerEvent<SVGElement>) {
    const held = drag.current;

    if (!held) return;
    const [x, y] = svgPoint(event);
    const least = Math.max(bounds.width, bounds.height) * SMALLEST_CROP;

    change(
      resizedBox(
        held.from,
        held.edges,
        [x - held.start[0], y - held.start[1]],
        bounds,
        least,
      ),
    );
  }

  const release = () => (drag.current = null);
  const outline = corners(frame)
    .map(([x, y]) => x + " " + y)
    .join(" L ");
  const size = HANDLE_PX / scale;
  const events = {
    onPointerMove: move,
    onPointerUp: release,
    onPointerCancel: release,
  };

  return (
    <g className="cropframe">
      <path
        className="cropshade"
        fillRule="evenodd"
        d={`M ${bounds.x} ${bounds.y} h ${bounds.width} v ${bounds.height} h ${-bounds.width} Z M ${outline} Z`}
      />
      <rect
        className="cropbody"
        {...frame}
        strokeWidth={1.5 / scale}
        onPointerDown={grab("move")}
        {...events}
      />
      {HANDLES.map((edges) => {
        const [x, y] = handleAt(edges, frame);

        return (
          <rect
            key={edges}
            className={"crophandle " + edges}
            x={x - size / 2}
            y={y - size / 2}
            width={size}
            height={size}
            strokeWidth={1 / scale}
            onPointerDown={grab(edges)}
            {...events}
          />
        );
      })}
    </g>
  );
}

export function CropActions({
  t,
  apply,
  reset,
  cancel,
}: {
  t: T;
  apply: () => void;
  reset: () => void;
  cancel: () => void;
}) {
  return (
    <div className="viewertools" role="toolbar" aria-label={t("toolCrop")}>
      <span className="viewerhint">{t("cropHint")}</span>
      <button className="viewertext" onClick={reset}>
        {t("cropReset")}
      </button>
      <button className="viewertext" onClick={cancel}>
        {t("cancel")}
      </button>
      <button className="primary" onClick={apply}>
        <Check />
        {t("cropApply")}
      </button>
    </div>
  );
}
