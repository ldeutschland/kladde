import { useMemo, useRef, type ReactNode } from "react";
import {
  apply,
  sheetMatrix,
  turnedSize,
  type Box,
  type Mark,
  type Matrix,
  type Tool,
  type Turn,
} from "./marks";
import { MarkShape, Marks } from "./MarkShapes";
import type { Pen } from "./sheetGestures";
import {
  DEFAULT_TEXT_SIZE,
  useSheetTyping,
  type SheetTyping,
} from "./useSheetTyping";
import { useSheetGestures } from "./useSheetGestures";

const MIN_TEXT_COLUMNS = 4;

export interface SheetProps {
  width: number;
  height: number;
  turn: Turn;
  flip?: boolean;
  view?: Box;
  scale: number;
  href?: string;
  marks: Mark[];
  tool: Tool | null;
  pen?: Pen;
  change?: (marks: Mark[]) => void;
  label: string;
  children?: ReactNode;
}

function textareaSize(text: string) {
  const lines = text.split("\n");

  return {
    rows: lines.length,
    cols: Math.max(MIN_TEXT_COLUMNS, ...lines.map((line) => line.length + 1)),
  };
}

function TypingField({
  props,
  typing,
  upright,
  box,
}: {
  props: SheetProps;
  typing: SheetTyping;
  upright: Matrix;
  box: Box;
}) {
  const { marks, pen, scale } = props;
  const typed = typing.typing;

  if (!typed) return null;
  const [x, y] = apply(upright, typed.at);
  const existing = typed.index >= 0 ? marks[typed.index] : undefined;
  const size = existing ? existing.width : (pen?.width ?? DEFAULT_TEXT_SIZE);

  return (
    <textarea
      ref={typing.field}
      className="sheettext"
      aria-label={props.label}
      value={typed.text}
      {...textareaSize(typed.text)}
      spellCheck={false}
      style={{
        left: (x - box.x) * scale,
        top: (y - box.y) * scale,
        fontSize: size * scale,
        color: existing ? existing.color : pen?.color,
      }}
      onChange={(event) =>
        typing.setTyping({ ...typed, text: event.target.value })
      }
      onKeyDown={typing.keys}
      onBlur={() => typing.finish(true)}
    />
  );
}

export function Sheet(props: SheetProps) {
  const { width, height, turn, flip = false, scale, marks, tool } = props;
  const group = useRef<SVGGElement>(null);
  const upright = useMemo(
    () => sheetMatrix(width, height, turn, flip),
    [width, height, turn, flip],
  );
  const [shownWidth, shownHeight] = turnedSize(width, height, turn);
  const box = props.view ?? {
    x: 0,
    y: 0,
    width: shownWidth,
    height: shownHeight,
  };
  const active = !!props.change && !!tool && tool !== "crop";
  const typing = useSheetTyping(props);
  const gestures = useSheetGestures({
    ...props,
    group,
    upright,
    active,
    typing,
  });
  const { gesture } = gestures;
  const typed = typing.typing;

  return (
    <div
      className="sheet"
      data-tool={props.change && tool ? tool : undefined}
      style={{ width: box.width * scale, height: box.height * scale }}
    >
      <svg
        viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
        width="100%"
        height="100%"
        role="img"
        aria-label={props.label}
        onPointerDown={gestures.down}
        onPointerMove={gestures.move}
        onPointerUp={gestures.up}
        onPointerCancel={gestures.up}
        onDoubleClick={gestures.doubleClick}
      >
        <g ref={group} transform={`matrix(${upright.join(" ")})`}>
          <rect width={width} height={height} fill="#ffffff" />
          {props.href && (
            <image
              href={props.href}
              width={width}
              height={height}
              preserveAspectRatio="none"
            />
          )}
          <Marks
            marks={
              typed && typed.index >= 0
                ? marks.filter((_, index) => index !== typed.index)
                : marks
            }
            upright={upright}
            hidden={gesture?.kind === "erase" ? gesture.hidden : undefined}
            drag={gesture?.kind === "drag" ? gesture : undefined}
          />
          {gesture?.kind === "draw" && (
            <MarkShape mark={gesture.mark} upright={upright} />
          )}
        </g>
        {props.children}
      </svg>
      <TypingField props={props} typing={typing} upright={upright} box={box} />
    </div>
  );
}
