import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { arrivesLater } from "../files/attachments";
import {
  unpack,
  type Entry,
  type Notebook,
  type Stored,
} from "../notebook/notebook";
import type { T } from "../locale/locale";
import {
  allVersions,
  keepVersion,
  listVersions,
  loadShared,
  loadVersion,
  shareVersions,
  versionKey,
  type Version,
} from "./versions";

interface HistoryOptions {
  entry: Entry;
  book: Notebook;
  t: T;
}

function loadStored(book: Notebook, entry: Entry, version: Version) {
  return version.foreign && version.file
    ? loadShared(book, entry, version.file)
    : loadVersion(entry.id, version.rev);
}

function useAttempt() {
  const [error, setError] = useState("");
  const attempt = useCallback(async (work: () => Promise<void>) => {
    setError("");

    try {
      await work();
    } catch (problem) {
      setError(String(problem));
    }
  }, []);

  return { error, setError, attempt };
}

export function useVersionHistory({ entry, book, t }: HistoryOptions) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [shown, setShown] = useState<Stored | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const { error, setError, attempt } = useAttempt();
  const guarded = useRef(false);
  const old = useMemo(
    () => shown && { ...entry, doc: unpack(shown.data) },
    [entry, shown],
  );
  const selected = versions?.find((version) => versionKey(version) === picked);
  const reload = useCallback(
    async () => setVersions(allVersions(await listVersions(entry.id), entry)),
    [entry],
  );
  const share = useCallback(async () => {
    await shareVersions(book, entry).catch(() => {});
    await reload();
  }, [book, entry, reload]);

  useEffect(() => {
    void attempt(async () => {
      await reload();
      await share();
    });
  }, [attempt, reload, share]);
  const snapshot = useCallback(async () => {
    await book.flush();
    await keepVersion(entry.id, null, "restore");
    guarded.current = true;
    await share();
  }, [book, entry.id, share]);
  const guard = useCallback(async () => {
    if (!guarded.current) await snapshot();
  }, [snapshot]);

  async function select(version: Version) {
    setError("");

    try {
      setShown(await loadStored(book, entry, version));
      setPicked(versionKey(version));
    } catch (problem) {
      const waiting = version.foreign && arrivesLater(problem, 0);

      setError(waiting ? t("versionArriving") : String(problem));
    }
  }

  return {
    versions,
    shown,
    setShown,
    picked,
    old,
    selected,
    error,
    attempt,
    share,
    snapshot,
    guard,
    select,
  };
}
