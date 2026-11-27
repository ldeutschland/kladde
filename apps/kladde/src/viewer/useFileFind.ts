import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { command } from "../platform/native";
import { findableQuery } from "../search/FindBar";
import type { FoundView, PageMarks } from "./foundMarks";
import type { PdfSource } from "./pdfPages";
import { fileMatches, firstFrom, pageMarks, type FileMatch } from "./fileFind";

interface Found {
  key: string;
  matches: FileMatch[];
  start: number;
}

const SEARCH_DELAY_MS = 250;
const NO_MATCHES: FileMatch[] = [];
const NO_MARKS = new Map<number, PageMarks>();

function useFileMatches(
  { space, doc, file }: PdfSource,
  query: string,
  startPage: RefObject<number>,
) {
  const term = query.trim();
  const key = [space, doc, file, term].join("\n");
  const [found, setFound] = useState<Found>();

  useEffect(() => {
    if (!term) return;
    let live = true;
    const request = { space, doc, file, term };
    const keep = (matches: FileMatch[]) => {
      if (live)
        setFound({
          key,
          matches,
          start: firstFrom(matches, startPage.current),
        });
    };
    const timer = setTimeout(() => {
      command<unknown>("find_all_in_attachment", request)
        .then((value) => keep(fileMatches(value)))
        .catch(() => keep(NO_MATCHES));
    }, SEARCH_DELAY_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, space, doc, file, term, startPage]);

  if (!term || !found)
    return { matches: NO_MATCHES, start: 0, searching: !!term };

  return { ...found, searching: found.key !== key };
}

export function useFileFind(source: PdfSource, initial: string, page: number) {
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const [query, setQuery] = useState("");
  const [requested, setRequested] = useState(0);
  const [chosen, setChosen] = useState({ matches: NO_MATCHES, index: 0 });
  const startPage = useRef(page);
  const { matches, start, searching } = useFileMatches(
    source,
    open ? query : "",
    startPage,
  );
  const current = chosen.matches === matches ? chosen.index : start;
  const marks = useMemo(
    () => (open ? pageMarks(matches, current) : NO_MARKS),
    [open, matches, current],
  );

  useEffect(() => {
    startPage.current = page;
  }, [page]);

  function show() {
    setOpen(true);
    setTouched(true);
    setQuery((known) => known || findableQuery(initial));
    setRequested((count) => count + 1);
  }

  function step(by: number) {
    if (!matches.length) return;
    const index = (current + by + matches.length) % matches.length;

    setChosen({ matches, index });
  }

  return {
    open,
    touched,
    query,
    setQuery,
    requested,
    total: matches.length,
    current,
    match: matches.at(current),
    searching,
    marks,
    show,
    hide: () => setOpen(false),
    step,
  };
}

export type FileFind = ReturnType<typeof useFileFind>;

export function useJumpToPageOnlyMatch(
  find: FileFind,
  go: (page: number) => void,
) {
  const { match } = find;

  useEffect(() => {
    if (match && !match.boxes.length) go(match.page);
  }, [match, go]);
}

export function shownMarks(
  find: FileFind,
  page: number,
  revealed: PageMarks | undefined,
): FoundView | undefined {
  if (find.open && find.query.trim()) {
    const marks = find.marks.get(page);

    return marks && { marks, centered: marks.current.length > 0 };
  }

  if (find.touched || !revealed) return undefined;

  return { marks: revealed, centered: true };
}
