import { memo } from "react";
import {
  MARKER_OPACITY,
  TEXT_BASELINE,
  TEXT_FONT,
  TEXT_INSET,
  TEXT_LINE,
  arrowHead,
  boxOf,
  invert,
  linear,
  moved,
  textLines,
  type Mark,
  type Matrix,
  type Point,
} from "./marks";

function points(list: Point[]) {
  return list.map(([x, y]) => x + "," + y).join(" ");
}

function TextMark({ mark, upright }: { mark: Mark; upright: Matrix }) {
  const [x, y] = mark.points[0];
  const turn = invert(linear(upright)).join(" ");

  return (
    <text
      className="mark"
      transform={`translate(${x} ${y}) matrix(${turn})`}
      fill={mark.color}
      fontSize={mark.width}
      fontFamily={TEXT_FONT}
    >
      {textLines(mark).map((line, index) => (
        <tspan
          key={index}
          x={mark.width * TEXT_INSET}
          y={mark.width * (TEXT_BASELINE + index * TEXT_LINE)}
        >
          {line || " "}
        </tspan>
      ))}
    </text>
  );
}

export function MarkShape({ mark, upright }: { mark: Mark; upright: Matrix }) {
  const stroke = {
    stroke: mark.color,
    strokeWidth: mark.width,
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  if (mark.kind === "text") return <TextMark mark={mark} upright={upright} />;

  if (mark.kind === "rect")
    return (
      <rect
        className="mark"
        {...stroke}
        strokeLinecap="butt"
        {...boxOf(mark.points)}
      />
    );

  if (mark.kind === "arrow")
    return (
      <g className="mark" {...stroke}>
        <polyline points={points(mark.points)} />
        <polyline points={points(arrowHead(mark))} />
      </g>
    );

  return (
    <polyline
      {...stroke}
      className={mark.kind === "marker" ? "mark markerstroke" : "mark"}
      opacity={mark.kind === "marker" ? MARKER_OPACITY : undefined}
      points={points(
        mark.points.length === 1
          ? [mark.points[0], mark.points[0]]
          : mark.points,
      )}
    />
  );
}

export const Marks = memo(function Marks({
  marks,
  upright,
  hidden,
  drag,
}: {
  marks: Mark[];
  upright: Matrix;
  hidden?: Set<number>;
  drag?: { index: number; by: Point };
}) {
  return marks.map((mark, index) => {
    if (hidden?.has(index)) return null;
    const shown = drag?.index === index ? moved(mark, ...drag.by) : mark;

    return <MarkShape key={index} mark={shown} upright={upright} />;
  });
});
