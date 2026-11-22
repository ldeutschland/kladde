import { useEffect, useRef, useState, type PointerEvent } from "react";

const DRAG_DISTANCE = 5;
const TOUCH_HOLD_MS = 350;
const EDGE_ZONE = 48;
const EDGE_SPEED = 14;

export interface CardDrag {
  id: string;
  x: number;
  y: number;
  width: number;
  column: string | null;
}

function columnAt(board: HTMLElement | null, x: number) {
  for (const column of board?.querySelectorAll<HTMLElement>("[data-column]") ??
    []) {
    const rect = column.getBoundingClientRect();

    if (x >= rect.left && x <= rect.right) return column.dataset.column ?? "";
  }

  return null;
}

function scrollNearEdge(board: HTMLElement | null, x: number) {
  if (!board) return;
  const rect = board.getBoundingClientRect();

  if (x < rect.left + EDGE_ZONE) board.scrollLeft -= EDGE_SPEED;
  if (x > rect.right - EDGE_ZONE) board.scrollLeft += EDGE_SPEED;
}

export function useCardDrag(drop: (id: string, column: string) => void) {
  const [drag, setDrag] = useState<CardDrag | null>(null);
  const dragged = useRef(false);
  const cancel = useRef<(() => void) | null>(null);

  useEffect(() => () => cancel.current?.(), []);

  function start(e: PointerEvent<HTMLElement>, id: string) {
    if (e.button !== 0 || cancel.current) return;
    const board = e.currentTarget.closest<HTMLElement>(".board");
    const origin = { x: e.clientX, y: e.clientY };
    const card = e.currentTarget.getBoundingClientRect();
    const place = (dx: number, dy: number, column: string | null) => ({
      id,
      x: card.left + dx,
      y: card.top + dy,
      width: card.width,
      column,
    });
    const touch = e.pointerType !== "mouse";
    let active = false;
    let column: string | null = null;

    const begin = () => {
      active = true;
      dragged.current = true;
      getSelection()?.removeAllRanges();
      setDrag(place(0, 0, null));
    };
    const hold = touch ? setTimeout(begin, TOUCH_HOLD_MS) : undefined;

    const finish = () => {
      clearTimeout(hold);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("touchmove", holdPage);
      cancel.current = null;
      setDrag(null);
      setTimeout(() => {
        dragged.current = false;
      });
    };
    const move = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - origin.x;
      const dy = ev.clientY - origin.y;

      if (!active && Math.hypot(dx, dy) < DRAG_DISTANCE) return;

      if (!active && touch) {
        finish();

        return;
      }

      if (!active) begin();
      column = columnAt(board, ev.clientX);
      scrollNearEdge(board, ev.clientX);
      setDrag(place(dx, dy, column));
    };
    const release = () => {
      const target = active ? column : null;

      finish();
      if (target !== null) drop(id, target);
    };
    const holdPage = (ev: TouchEvent) => {
      if (active) ev.preventDefault();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("touchmove", holdPage, { passive: false });
    cancel.current = finish;
  }

  return { drag, start, wasDragged: () => dragged.current };
}
