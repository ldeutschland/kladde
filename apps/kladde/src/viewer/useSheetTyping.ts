import { useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { compact, type Mark, type Point } from "./marks";
import type { Pen } from "./sheetGestures";

const DEFAULT_TEXT_COLOR = "#191919";

export const DEFAULT_TEXT_SIZE = 16;
const TRAILING_SPACE = /\s+$/;

export interface Typing {
  at: Point;
  index: number;
  text: string;
}

interface TypingOptions {
  marks: Mark[];
  pen?: Pen;
  change?: (marks: Mark[]) => void;
}

function typedMarks(typed: Typing, options: TypingOptions) {
  const { marks, pen } = options;
  const text = typed.text.replace(TRAILING_SPACE, "");
  const rest = marks.filter((_, index) => index !== typed.index);

  if (!text.trim()) return typed.index >= 0 ? rest : null;
  const base = typed.index >= 0 ? marks[typed.index] : undefined;
  const mark: Mark = {
    kind: "text",
    color: base?.color ?? pen?.color ?? DEFAULT_TEXT_COLOR,
    width: base?.width ?? pen?.width ?? DEFAULT_TEXT_SIZE,
    points: [typed.at],
    text,
  };

  if (typed.index < 0) return [...marks, compact(mark)];

  return marks.map((old, index) =>
    index === typed.index ? compact(mark) : old,
  );
}

export function useSheetTyping(options: TypingOptions) {
  const { marks } = options;
  const field = useRef<HTMLTextAreaElement>(null),
    open = useRef(false);
  const [typing, setTyping] = useState<Typing | null>(null);

  function start(at: Point, index: number) {
    const text = index >= 0 ? (marks[index].text ?? "") : "";

    open.current = true;
    flushSync(() =>
      setTyping({ at: index >= 0 ? marks[index].points[0] : at, index, text }),
    );
    field.current?.focus();
  }

  function finish(keep: boolean) {
    if (!open.current) return;
    open.current = false;
    const current = typing;

    setTyping(null);
    if (!current || !keep || !options.change) return;
    const next = typedMarks(current, options);

    if (next) options.change(next);
  }

  function keys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      finish(true);
    }
  }

  return { typing, setTyping, field, start, finish, keys };
}

export type SheetTyping = ReturnType<typeof useSheetTyping>;
