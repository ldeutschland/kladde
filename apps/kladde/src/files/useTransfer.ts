import { useState } from "react";
import { Notebook } from "../notebook/notebook";
import { copyPages } from "../notebook/copyPages";
import { command } from "../platform/native";
import type { T } from "../locale/locale";
import type { Ask } from "../ui/dialog";
import { restoreBackup } from "./backup";
import { download } from "./download";
import { importFiles } from "./importFiles";
import { zipNotebook } from "./zipNotebook";

export const BACKUP_SUFFIX = ".kladde";
const BACKUP_NAME = "Kladde.kladde";

interface TransferOptions {
  book: Notebook;
  t: T;
  ask: Ask;
  open: (id: string) => void;
}

type TransferTask = ReturnType<typeof useTransferTask>;

function reason(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function useTransferTask() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function work(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");

    try {
      await task();
    } catch (error) {
      setMessage(reason(error));
    } finally {
      setBusy(false);
    }
  }

  return { message, setMessage, busy, work };
}

function useBookMove({ book, t, ask }: TransferOptions, task: TransferTask) {
  const [target, setTarget] = useState("");
  const [pageId, setPageId] = useState("");

  async function move() {
    if (!target || !pageId) return;
    const confirmed = await ask(t("moveBookQuestion"), undefined, {
      action: t("move"),
    });

    if (!confirmed) return;
    await task.work(async () => {
      const destination = await Notebook.open(target);

      await copyPages(book, destination, pageId, true);
      setPageId("");
      task.setMessage(t("moved"));
    });
  }

  return { target, setTarget, pageId, setPageId, move };
}

export function useTransfer(options: TransferOptions) {
  const { book, t, ask, open } = options;
  const task = useTransferTask();
  const { work, setMessage } = task;
  const bookMove = useBookMove(options, task);

  const importList = (list: File[]) =>
    work(async () => {
      setMessage(t("importBusy"));
      const first = await importFiles(book, list);

      if (first) open(first);
      else setMessage(t("importUnsupported"));
    });
  const exportAll = () =>
    work(async () => {
      download("Kladde.zip", await zipNotebook(book), "application/zip");
      setMessage(t("exported"));
    });

  async function backup() {
    const password = await ask(t("backup"), "", {
      secret: true,
      placeholder: t("password") + " (≥12)",
      action: t("save"),
    });

    if (!password) return;
    await work(async () => {
      await book.flush();
      const saved = await command<string>("export_backup", {
        space: book.id,
        password,
        name: BACKUP_NAME,
      });

      setMessage(t("backupSaved").replace("{name}", saved));
    });
  }

  async function restore(list: File[]) {
    const file = list[0];

    if (!file.name.toLowerCase().endsWith(BACKUP_SUFFIX)) {
      setMessage(t("restoreWrongFile"));

      return;
    }

    const password = await ask(t("password"), "", {
      secret: true,
      action: t("restore"),
    });

    if (!password) return;
    await work(async () => {
      await restoreBackup(file, password, (done) =>
        setMessage(Math.round(done * 100) + " %"),
      );
      location.reload();
    });
  }

  return { ...task, ...bookMove, importList, exportAll, backup, restore };
}
