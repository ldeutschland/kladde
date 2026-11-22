import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Entry, Notebook } from "../notebook/notebook";
import { localDate } from "../database/rules";
import { computeScope, rowSnapshot } from "../database/computedRows";
import { retainRows } from "../database/rowIndex";
import { type Row } from "../database/types";
import type { ComputeScope } from "../database/compute";

const DAY_CHECK_MS = 30000;
const PAGE_SCROLLERS = ".document, .panel";

export function useToday() {
  const [today, updateDay] = useState(localDate);

  useEffect(() => {
    const refresh = () => updateDay(localDate());
    const timer = setInterval(refresh, DAY_CHECK_MS);

    window.addEventListener("focus", refresh);

    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  return today;
}

export function useRows(book: Notebook, db: Entry) {
  const [rows, setRows] = useState<Row[]>([]);
  const [scope, setScope] = useState<ComputeScope>(() => computeScope(book));
  const shownRows = useRef("");

  useEffect(() => retainRows(book, db.id), [book, db]);
  useEffect(() => {
    let current = true;
    const partial = (loaded: Row[]) => {
      if (current) setRows(loaded);
    };
    const load = async () => {
      const snapshot = await rowSnapshot(book, db, partial);

      if (!current || snapshot.key === shownRows.current) return;
      shownRows.current = snapshot.key;
      setScope(snapshot.scope);
      setRows(snapshot.rows);
    };

    if (!book.dirty.size && !book.busy) void load();

    return () => {
      current = false;
    };
  }, [book, db, book.tick]);

  return { rows, setRows, scope };
}

export function useScrollOffset(
  mobile: boolean,
  view: string | undefined,
  type: string | undefined,
) {
  const [offset, scroll] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = viewport.current;
    const scroller = element?.closest<HTMLElement>(PAGE_SCROLLERS);

    if (!mobile || !element || !scroller) return;
    const follow = () =>
      scroll(
        Math.max(
          0,
          scroller.getBoundingClientRect().top -
            element.getBoundingClientRect().top,
        ),
      );

    follow();
    scroller.addEventListener("scroll", follow, { passive: true });

    return () => scroller.removeEventListener("scroll", follow);
  }, [mobile, view, type]);

  return { offset, scroll, viewport };
}

function measureRows(list: HTMLDivElement | null, sizes: Map<string, number>) {
  let changed = false;

  for (const element of list?.children ?? []) {
    const key = element instanceof HTMLElement ? element.dataset.key : "";

    if (!key) continue;
    const size = (element as HTMLElement).offsetHeight;

    if (sizes.get(key) === size) continue;
    sizes.set(key, size);
    changed = true;
  }

  return changed;
}

export function useRowHeights() {
  const measured = useRef(new Map<string, number>()),
    measuredLayout = useRef(""),
    rowList = useRef<HTMLDivElement>(null);
  const [, remeasure] = useState(0);

  useLayoutEffect(() => {
    if (measureRows(rowList.current, measured.current)) remeasure((n) => n + 1);
  });

  function heightsFor(layout: string) {
    if (measuredLayout.current !== layout) {
      measuredLayout.current = layout;
      measured.current.clear();
    }

    return measured.current;
  }

  return { rowList, heightsFor };
}
