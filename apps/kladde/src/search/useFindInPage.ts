import { useEffect, useState, type RefObject } from "react";
import {
  clearFound,
  findRanges,
  firstInView,
  paintFound,
  revealRange,
  selectRange,
} from "./findInPage";

const REFRESH_MS = 150;

interface Found {
  ranges: Range[];
  current: number;
}

const NOTHING: Found = { ranges: [], current: 0 };

function freshlyFound(root: HTMLElement, query: string): Found {
  const ranges = findRanges(root, query);
  const current = firstInView(ranges, root);

  revealRange(ranges[current], root);

  return { ranges, current };
}

function refound(root: HTMLElement, query: string, previous: Found): Found {
  const ranges = findRanges(root, query);
  const current = Math.min(previous.current, Math.max(ranges.length - 1, 0));

  return { ranges, current };
}

function watchChanges(root: HTMLElement, refresh: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(refresh, REFRESH_MS);
  });

  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  return () => {
    observer.disconnect();
    clearTimeout(timer);
  };
}

export function useFindInPage(
  root: RefObject<HTMLElement | null>,
  query: string,
) {
  const [found, setFound] = useState(NOTHING);

  useEffect(() => {
    const element = root.current;

    if (!element) return;
    setFound(freshlyFound(element, query));

    return watchChanges(element, () =>
      setFound((previous) => refound(element, query, previous)),
    );
  }, [root, query]);
  useEffect(() => paintFound(found.ranges, found.current), [found]);
  useEffect(() => clearFound, []);

  function step(by: number) {
    const { ranges, current } = found;

    if (!ranges.length || !root.current) return;
    const next = (current + by + ranges.length) % ranges.length;

    setFound({ ranges, current: next });
    revealRange(ranges[next], root.current);
  }

  return {
    total: found.ranges.length,
    current: found.current,
    step,
    select: () => selectRange(found.ranges[found.current]),
  };
}

export type FindInPage = ReturnType<typeof useFindInPage>;
