import { useEffect, useState } from "react";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";

const MIN_RAIL = 180;
const MAX_RAIL = 400;
const DEFAULT_RAIL = 240;
const SAVE_RAIL_MS = 400;

function clampRail(width: number) {
  return Math.max(MIN_RAIL, Math.min(MAX_RAIL, Math.round(width)));
}

function savedRail(book: Notebook) {
  const stored = book.settings.get("sidebarWidth");

  return typeof stored === "number" && Number.isFinite(stored)
    ? clampRail(stored)
    : DEFAULT_RAIL;
}

export function useRail(book: Notebook) {
  const [rail, setRail] = useState(() => savedRail(book));

  useEffect(() => {
    if (book.settings.get("sidebarWidth") === rail) return;
    const timer = setTimeout(
      () => book.settings.set("sidebarWidth", rail),
      SAVE_RAIL_MS,
    );

    return () => clearTimeout(timer);
  }, [book, rail]);

  return [rail, setRail] as const;
}

export function RailResizer({
  rail,
  setRail,
  t,
}: {
  rail: number;
  setRail: (width: number) => void;
  t: T;
}) {
  return (
    <input
      className="resizer"
      aria-label={t("width")}
      type="range"
      min={MIN_RAIL}
      max={MAX_RAIL}
      value={rail}
      onChange={(e) => setRail(Number(e.target.value))}
      onDoubleClick={() => setRail(DEFAULT_RAIL)}
      onPointerDown={(e) => {
        const handle = e.currentTarget,
          start = e.clientX,
          from = rail;

        handle.setPointerCapture(e.pointerId);
        handle.onpointermove = (ev) =>
          setRail(clampRail(from + ev.clientX - start));

        handle.onpointerup = () => {
          handle.onpointermove = null;
        };
      }}
    />
  );
}
