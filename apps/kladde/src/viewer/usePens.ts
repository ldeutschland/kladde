import { useState } from "react";
import {
  SIZES,
  STARTING_COLORS,
  strokeWidth,
  type MarkKind,
  type Tool,
} from "./marks";
import type { Pen } from "./sheetGestures";

function isMarkKind(tool: Tool): tool is MarkKind {
  return tool in SIZES;
}

export function usePens(initial: Tool) {
  const [tool, setTool] = useState<Tool>(initial);
  const [colors, setColors] = useState(STARTING_COLORS);
  const [sizes, setSizes] = useState<Record<MarkKind, number>>({
    pen: 1,
    marker: 1,
    arrow: 1,
    rect: 1,
    text: 1,
  });
  const kind = isMarkKind(tool) ? tool : null;

  return {
    tool,
    setTool,
    kind,
    color: kind ? colors[kind] : null,
    size: kind ? sizes[kind] : null,
    setColor: (color: string) =>
      kind && setColors({ ...colors, [kind]: color }),
    setSize: (size: number) => kind && setSizes({ ...sizes, [kind]: size }),
    penFor: (width: number, height: number): Pen | undefined =>
      kind
        ? {
            kind,
            color: colors[kind],
            width: strokeWidth(kind, sizes[kind], width, height),
          }
        : undefined,
  };
}

export type Pens = ReturnType<typeof usePens>;
