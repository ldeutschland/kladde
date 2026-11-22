import { useEffect } from "react";
import type { Notebook } from "../notebook/notebook";
import { shareLater } from "../versions/versions";
import { keepEditsOf } from "../files/fileEdits";

export function useBookEvents(book: Notebook) {
  useEffect(() => {
    book.onSaved = (saved) => shareLater(book, saved);
    book.onArrived = (entry) => void keepEditsOf(book, entry).catch(() => {});

    return () => {
      book.onSaved = undefined;
      book.onArrived = undefined;
    };
  }, [book]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) void book.flush();
    };

    document.addEventListener("visibilitychange", hidden);

    return () => document.removeEventListener("visibilitychange", hidden);
  }, [book]);
}
