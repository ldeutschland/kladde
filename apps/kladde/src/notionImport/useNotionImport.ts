import { useState } from "react";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { importNotion, type NotionResult } from "./notionImport";

function summary(t: T, result: NotionResult) {
  return t("notionDone")
    .replace("{pages}", String(result.pages))
    .replace("{databases}", String(result.databases))
    .replace("{files}", String(result.files));
}

function progressText(t: T, done: number, total: number) {
  return t("notionProgress")
    .replace("{done}", String(done))
    .replace("{total}", String(total));
}

function reason(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useNotionImport(book: Notebook, t: T) {
  const [remoteImages, setRemoteImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [skipped, setSkipped] = useState<string[]>([]);
  const [first, setFirst] = useState("");

  async function run(list: File[]) {
    if (!list.length || busy) return;
    setBusy(true);
    setSkipped([]);
    setFirst("");
    setStatus("");

    try {
      const result = await importNotion(book, list, {
        root: null,
        remoteImages,
        progress: (done, total) => setStatus(progressText(t, done, total)),
      });

      setStatus(summary(t, result));
      setSkipped(result.skipped);
      setFirst(result.first);
    } catch (error) {
      setStatus(reason(error));
    } finally {
      setBusy(false);
    }
  }

  return { remoteImages, setRemoteImages, busy, status, skipped, first, run };
}
