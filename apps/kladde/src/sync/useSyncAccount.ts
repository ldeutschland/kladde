import { useEffect, useRef, useState } from "react";
import { command } from "../platform/native";
import { statusFromError, statusFromReport, syncBook } from "./sync";
import {
  readableError,
  type AccountInfo,
  type RecoveryPhrase,
  type SyncAction,
  type SyncPanelProps,
} from "./accountTypes";

export function useSyncAccount(props: SyncPanelProps) {
  const { book, t, setStatus } = props;
  const [info, setInfo] = useState<AccountInfo | null | undefined>(null),
    [action, setAction] = useState<SyncAction>(
      props.status.phase === "auth" ? "renew" : "login",
    ),
    [phrase, setPhrase] = useState<RecoveryPhrase | null>(null),
    [busy, setBusy] = useState(false),
    [error, fail] = useState("");
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    void command<AccountInfo | null>("account_info")
      .then(setInfo)
      .catch((problem) => {
        setInfo(undefined);
        fail(readableError(problem, t));
      });
  }, []);

  async function syncInto(space: string) {
    setStatus((status) => ({ ...status, phase: "syncing" }));

    try {
      const report = await syncBook(book, space);

      setStatus((status) => statusFromReport(report, status));
    } catch (problem) {
      setStatus((status) => statusFromError(problem, status));
      if (String(problem).includes("sync:auth")) setAction("renew");
      throw problem;
    }
  }

  async function attempt(work: () => Promise<void>) {
    setBusy(true);
    fail("");

    try {
      await work();
    } catch (problem) {
      fail(readableError(problem, t));
    } finally {
      setBusy(false);
    }
  }

  async function repair() {
    const confirmed = await props.ask(t("repairSyncQuestion"), undefined, {
      detail: t("repairSyncDetail"),
      action: t("repairSync"),
    });

    if (!confirmed) return;
    await attempt(async () => {
      await command("repair_sync", { space: book.id });
      await syncInto(book.id);
    });
  }

  function chooseAction(next: SyncAction) {
    setAction(next);
    setPhrase(null);
    fail("");
  }

  return {
    info,
    setInfo,
    action,
    setAction,
    phrase,
    setPhrase,
    busy,
    setBusy,
    error,
    fail,
    form,
    syncInto,
    attempt,
    repair,
    chooseAction,
  };
}

export type SyncAccount = ReturnType<typeof useSyncAccount>;
