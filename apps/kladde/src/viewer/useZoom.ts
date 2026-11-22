import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Stage } from "./useStage";

const ZOOM_STEPS = [0.25, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4, 6];
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
const WHEEL_ZOOM = 0.01;
const CLOSER_ZOOM = 2;

function clampZoom(zoom: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

interface GestureEvent extends UIEvent {
  scale: number;
}

interface Anchor {
  ratio: number;
  x: number;
  y: number;
}

export function useZoom(stage: Stage) {
  const [zoom, setZoom] = useState(1);
  const anchor = useRef<Anchor | null>(null);
  const current = useRef(zoom);

  current.current = zoom;
  const zoomAround = useCallback(
    (next: number, x?: number, y?: number) => {
      const element = stage.ref.current;
      const target = clampZoom(next);

      if (!element || target === current.current) return;
      const rect = element.getBoundingClientRect();

      anchor.current = {
        ratio: target / current.current,
        x: (x ?? rect.left + rect.width / 2) - rect.left,
        y: (y ?? rect.top + rect.height / 2) - rect.top,
      };
      setZoom(target);
    },
    [stage.ref],
  );

  useLayoutEffect(() => {
    const element = stage.ref.current,
      held = anchor.current;

    anchor.current = null;
    if (!element || !held) return;
    element.scrollLeft = (element.scrollLeft + held.x) * held.ratio - held.x;
    element.scrollTop = (element.scrollTop + held.y) * held.ratio - held.y;
  }, [zoom, stage.ref]);
  const { element } = stage;

  useEffect(() => {
    if (!element) return;
    let start = 1;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAround(
        current.current * Math.exp(-event.deltaY * WHEEL_ZOOM),
        event.clientX,
        event.clientY,
      );
    };
    const begin = (event: Event) => {
      event.preventDefault();
      start = current.current;
    };
    const pinch = (event: Event) => {
      event.preventDefault();
      zoomAround(start * (event as GestureEvent).scale);
    };

    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("gesturestart", begin);
    element.addEventListener("gesturechange", pinch);

    return () => {
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("gesturestart", begin);
      element.removeEventListener("gesturechange", pinch);
    };
  }, [element, zoomAround]);

  return {
    zoom,
    zoomIn: () =>
      zoomAround(ZOOM_STEPS.find((step) => step > zoom + 0.001) ?? MAX_ZOOM),
    zoomOut: () =>
      zoomAround(
        [...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.001) ??
          MIN_ZOOM,
      ),
    fit: () => zoomAround(1),
    toggle: (x: number, y: number) =>
      zoomAround(current.current === 1 ? CLOSER_ZOOM : 1, x, y),
  };
}

export type Zoom = ReturnType<typeof useZoom>;
