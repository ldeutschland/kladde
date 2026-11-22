import { useCallback, useEffect, useState, type DragEvent } from "react";
import { rotated, type Mark } from "./marks";
import { forgetPagePictures, type PdfInfo } from "./pdfPages";
import { moveItem, originalPages, type PageDraft } from "./pdfDraft";

export interface PageDrag {
  start: (index: number) => void;
  over: (event: DragEvent, index: number) => void;
  drop: (index: number) => void;
  marked: boolean;
}

interface PageHistory {
  commit: (update: (pages: PageDraft[]) => PageDraft[]) => void;
  reset: (pages: PageDraft[]) => void;
}

export function usePageEdits(
  history: PageHistory,
  info: PdfInfo | null | undefined,
  editing: boolean,
) {
  const [dragging, setDragging] = useState<{
    from: number;
    over: number;
  } | null>(null);
  const { reset, commit } = history;

  useEffect(() => {
    if (info) reset(originalPages(info));
  }, [info, reset]);
  useEffect(() => forgetPagePictures, []);

  const changeMarks = useCallback(
    (index: number, marks: Mark[]) =>
      commit((list) =>
        list.map((page, at) => (at === index ? { ...page, marks } : page)),
      ),
    [commit],
  );
  const turn = (index: number, by: 90 | -90) =>
    commit((list) =>
      list.map((page, at) =>
        at === index ? { ...page, turn: rotated(page.turn, by) } : page,
      ),
    );
  const move = (from: number, to: number) =>
    commit((list) => moveItem(list, from, to));
  const remove = (index: number) =>
    commit((list) =>
      list.length > 1 ? list.filter((_, at) => at !== index) : list,
    );

  function dragFor(index: number): PageDrag | undefined {
    if (!editing) return undefined;

    return {
      start: (from) => setDragging({ from, over: from }),
      over: (event, over) => {
        if (!dragging) return;
        event.preventDefault();
        if (dragging.over !== over) setDragging({ ...dragging, over });
      },
      drop: (to) => {
        if (dragging && dragging.from !== to) move(dragging.from, to);
        setDragging(null);
      },
      marked: !!dragging && dragging.over === index && dragging.from !== index,
    };
  }

  return { changeMarks, turn, move, remove, dragFor };
}
