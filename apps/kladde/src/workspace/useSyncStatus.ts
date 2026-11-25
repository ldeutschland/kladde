import { useEffect, useRef, useState } from "react";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { SYNC_OFF, withFiles, type SyncStatus } from "../sync/sync";
import { startSyncLoop } from "../sync/syncLoop";
import { mergeAiTrees } from "../ai/aiPages";

function recoveredText(titles: string[], t: T) {
  return t("syncRecovered").replace(
    "{titles}",
    titles.map((title) => title || t("untitled")).join(", "),
  );
}

export function useSyncStatus(
  book: Notebook,
  t: T,
  notify: (text: string) => void,
  removed: (ids: string[]) => void,
) {
  const [status, setStatus] = useState<SyncStatus>(SYNC_OFF),
    [slow, setSlow] = useState(false);
  const onRemoved = useRef(removed);

  onRemoved.current = removed;
  useEffect(
    () =>
      startSyncLoop(book, {
        status: setStatus,
        slow: setSlow,
        result: (report) => {
          if (report.recovered.length)
            notify(recoveredText(report.recovered, t));
          if (report.changed.length) void mergeAiTrees(book).catch(() => {});
          onRemoved.current(report.removed);
        },
      }),
    [book, t, notify],
  );
  const seen = withFiles(status);
  const shown: SyncStatus = slow ? { ...seen, phase: "syncing" } : seen;

  return { seen, shown, setStatus };
}

export type Sync = ReturnType<typeof useSyncStatus>;
