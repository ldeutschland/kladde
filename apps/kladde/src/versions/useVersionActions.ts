import type { Ask } from "../ui/dialog";
import { restoreContent } from "../notebook/content";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { useVersionHistory } from "./useVersionHistory";
import {
  cleanLabel,
  deleteVersion,
  dropShared,
  fullTime,
  keepVersion,
  labelVersion,
  type Version,
} from "./versions";

interface ActionOptions {
  entry: Entry;
  book: Notebook;
  lang: string;
  t: T;
  ask: Ask;
  notify: (text: string) => void;
  close: () => void;
}

type History = ReturnType<typeof useVersionHistory>;

function askName(ask: Ask, t: T, initial: string) {
  return ask(t("versionNamePrompt"), initial, {
    detail: t("versionNameHint"),
    placeholder: t("versionNamePlaceholder"),
    action: t("save"),
  });
}

function confirmDelete(ask: Ask, t: T, version: Version, lang: string) {
  const detail = t("versionDeleteDetail").replace(
    "{time}",
    fullTime(version, lang),
  );
  const options = { detail, action: t("delete"), danger: true };

  return ask(t("versionDeleteQuestion"), undefined, options);
}

export function useVersionActions(history: History, options: ActionOptions) {
  const { entry, book, lang, t, ask, notify, close } = options;
  const { attempt, share, setShown } = history;

  const keepCurrent = () =>
    attempt(async () => {
      const label = cleanLabel((await askName(ask, t, "")) ?? "");

      if (!label) return;
      await book.flush();
      await keepVersion(entry.id, label);
      await share();
      notify(t("versionKept"));
    });
  const rename = (version: Version) =>
    attempt(async () => {
      const label = cleanLabel(
        (await askName(ask, t, version.label ?? "")) ?? "",
      );

      if (!label) return;
      await labelVersion(entry.id, version.rev, label);
      await share();
    });
  const unname = (version: Version) =>
    attempt(async () => {
      await labelVersion(entry.id, version.rev, null);
      await share();
    });
  const remove = (version: Version) =>
    attempt(async () => {
      if (!(await confirmDelete(ask, t, version, lang))) return;
      if (version.foreign && version.file)
        await dropShared(book, entry, version.file);
      else await deleteVersion(entry.id, version.rev);
      setShown(null);
      await share();
    });
  const restoreAll = () =>
    attempt(async () => {
      const { old, shown } = history;

      if (!old || !shown) return;
      await history.snapshot();
      restoreContent(entry, old);
      await book.change(entry.id, { title: shown.title });
      await book.flush();
      notify(t("versionRestored"));
      close();
    });

  return { keepCurrent, rename, unname, remove, restoreAll };
}
