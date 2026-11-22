import { useEffect, useState } from "react";
import { FILE_RETRY_MS, arrivesLater } from "../files/attachments";
import { command } from "../platform/native";
import type { Entry, Notebook } from "../notebook/notebook";

export type PdfPreview = [number, string];

const FILE_PREFIX_LENGTH = "kladde-file:".length;

export function usePdfPreview(
  book: Notebook,
  entry: Entry,
  url: string,
  index: number,
) {
  const [preview, setPreview] = useState<PdfPreview | null>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => setAttempt(0), [url, index]);
  useEffect(() => {
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;

    setPreview(undefined);
    setError("");
    command<PdfPreview | null>("preview_attachment", {
      space: book.id,
      doc: entry.id,
      file: url.slice(FILE_PREFIX_LENGTH),
      index,
    })
      .then((result) => {
        if (current) setPreview(result);
      })
      .catch((problem) => {
        if (!current) return;

        if (arrivesLater(problem, attempt)) {
          retry = setTimeout(
            () => setAttempt(attempt + 1),
            FILE_RETRY_MS[attempt],
          );

          return;
        }

        setPreview(null);
        setError(String(problem));
      });

    return () => {
      current = false;
      clearTimeout(retry);
    };
  }, [book, entry, url, index, attempt]);

  return { preview, error };
}
