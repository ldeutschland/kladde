import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { PdfInfo } from "./pdfPages";
import type { Stage } from "./useStage";

const FOCUS_LINE = 0.35;

function pageAtLine(list: HTMLElement, line: number) {
  let low = 0,
    high = list.children.length - 1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if ((list.children[middle] as HTMLElement).offsetTop <= line) low = middle;
    else high = middle - 1;
  }

  return low;
}

export function useCurrentPage(
  element: HTMLElement | null,
  column: RefObject<HTMLElement | null>,
  count: number,
) {
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const list = column.current;

      if (!list?.children.length) return;
      const line =
        element.scrollTop + element.clientHeight * FOCUS_LINE - list.offsetTop;

      setCurrent(pageAtLine(list, line));
    };
    const scrolled = () => {
      frame ||= requestAnimationFrame(measure);
    };

    element.addEventListener("scroll", scrolled, { passive: true });
    measure();

    return () => {
      element.removeEventListener("scroll", scrolled);
      cancelAnimationFrame(frame);
    };
  }, [element, column, count]);

  return current;
}

interface ScrollOptions {
  stage: Stage;
  column: RefObject<HTMLElement | null>;
  padding: number;
  info: PdfInfo | null | undefined;
  stageWidth: number;
  startPage: number | undefined;
}

export function usePageJump(options: ScrollOptions) {
  const { stage, column, padding, info, stageWidth, startPage } = options;
  const opened = useRef(false);
  const go = useCallback(
    (index: number) => {
      const element = stage.ref.current,
        list = column.current;
      const page = list?.children[index] as HTMLElement | undefined;

      if (element && list && page)
        element.scrollTop = list.offsetTop + page.offsetTop - padding / 2;
    },
    [padding],
  );

  useLayoutEffect(() => {
    if (opened.current || !info || !stageWidth) return;
    opened.current = true;
    if (startPage) go(Math.min(startPage, info.sizes.length - 1));
  }, [info, stageWidth, startPage, go]);

  return go;
}
