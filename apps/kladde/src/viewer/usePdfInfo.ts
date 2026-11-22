import { useEffect, useState } from "react";
import { FILE_RETRY_MS, arrivesLater } from "../files/attachments";
import { pdfInfo, type PdfInfo, type PdfSource } from "./pdfPages";

export function usePdfInfo({ space, doc, file }: PdfSource) {
  const [info, setInfo] = useState<PdfInfo | null>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;

    pdfInfo({ space, doc, file })
      .then((found) => current && setInfo(found))
      .catch((problem) => {
        if (!current) return;
        if (arrivesLater(problem, attempt))
          retry = setTimeout(
            () => setAttempt(attempt + 1),
            FILE_RETRY_MS[attempt],
          );
        else setInfo(null);
      });

    return () => {
      current = false;
      clearTimeout(retry);
    };
  }, [space, doc, file, attempt]);

  return info;
}
