import {
  blocksBetween,
  blurActive,
  startsSelection,
  type Area,
} from "./selectionDom";

const DRAG_THRESHOLD = 4;
const SCROLL_EDGE = 48;
const SCROLL_STEP = 18;

interface Drag {
  x: number;
  y: number;
  scroll: number;
  additive: string[];
  moved: boolean;
}

interface Pointer {
  x: number;
  y: number;
}

export interface DragSelectTarget {
  root: HTMLElement;
  scroller: HTMLElement;
  picked: () => string[];
  setPicked: (ids: string[]) => void;
  setBox: (box: Area | null) => void;
}

function draggedEdges(drag: Drag, pointer: Pointer, scroller: HTMLElement) {
  const startY = drag.y - (scroller.scrollTop - drag.scroll);

  return {
    top: Math.min(startY, pointer.y),
    bottom: Math.max(startY, pointer.y),
    left: Math.min(drag.x, pointer.x),
    right: Math.max(drag.x, pointer.x),
  };
}

function scrollNearEdge(scroller: HTMLElement, pointer: Pointer) {
  const bounds = scroller.getBoundingClientRect();

  if (pointer.y < bounds.top + SCROLL_EDGE) scroller.scrollTop -= SCROLL_STEP;
  else if (pointer.y > bounds.bottom - SCROLL_EDGE)
    scroller.scrollTop += SCROLL_STEP;
}

function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };

  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() =>
    window.removeEventListener("click", swallow, { capture: true }),
  );
}

export function listenForDragSelect(target: DragSelectTarget) {
  const { root, scroller } = target;
  let drag: Drag | null = null;
  let pointer: Pointer = { x: 0, y: 0 };
  let frame = 0;

  const update = () => {
    if (!drag) return;
    const { top, bottom, left, right } = draggedEdges(drag, pointer, scroller);

    target.setBox({ top, left, width: right - left, height: bottom - top });
    const hits = blocksBetween(root, top, bottom);

    target.setPicked([...new Set([...drag.additive, ...hits])]);
  };

  const autoScroll = () => {
    if (!drag?.moved) return;
    scrollNearEdge(scroller, pointer);
    update();
    frame = requestAnimationFrame(autoScroll);
  };

  const move = (event: MouseEvent) => {
    if (!drag) return;
    pointer = { x: event.clientX, y: event.clientY };
    const distance = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);

    if (!drag.moved && distance < DRAG_THRESHOLD) return;

    if (!drag.moved) {
      drag.moved = true;
      frame = requestAnimationFrame(autoScroll);
    }

    update();
  };

  const up = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (drag?.moved) swallowNextClick();
    drag = null;
    target.setBox(null);
  };

  const down = (event: MouseEvent) => {
    if (event.button !== 0 || !startsSelection(event.target)) return;
    event.preventDefault();
    const additive = event.shiftKey ? target.picked() : [];

    if (!additive.length) target.setPicked([]);
    blurActive();
    drag = {
      x: event.clientX,
      y: event.clientY,
      scroll: scroller.scrollTop,
      additive,
      moved: false,
    };
    pointer = { x: event.clientX, y: event.clientY };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  scroller.addEventListener("mousedown", down);

  return () => {
    scroller.removeEventListener("mousedown", down);
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    cancelAnimationFrame(frame);
  };
}
