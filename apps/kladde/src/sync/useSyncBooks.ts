import { useEffect, useState } from "react";
import { command } from "../platform/native";
import { SYNC_OFF } from "./sync";
import { readableError, type SyncPanelProps } from "./accountTypes";
import type { SyncAccount } from "./useSyncAccount";
import type { Word } from "../locale/locale";

export interface SyncChoice {
  id: string;
  title: string | null;
  local: boolean;
  remote: boolean;
  excluded: boolean;
  primary: boolean;
}

export type ChoiceState =
  "synced" | "arriving" | "local" | "excludedHere" | "excludedAway";

const STATE_WORDS: Record<ChoiceState, Word> = {
  synced: "synced",
  arriving: "bookArriving",
  local: "unsynced",
  excludedHere: "bookExcludedHere",
  excludedAway: "bookExcludedAway",
};

export function choiceState(choice: SyncChoice): ChoiceState {
  if (!choice.remote) return "local";
  if (!choice.excluded) return choice.local ? "synced" : "arriving";

  return choice.local ? "excludedHere" : "excludedAway";
}

export function choiceWord(choice: SyncChoice) {
  return STATE_WORDS[choiceState(choice)];
}

export function loadChoices(refresh: boolean) {
  return command<SyncChoice[]>("sync_choices", { refresh });
}

export function syncsHere(choice: SyncChoice) {
  return choice.remote && !choice.excluded;
}

export function removable(choice: SyncChoice) {
  return choice.local && choice.remote && !choice.primary;
}

function arrivingIds(choices: SyncChoice[]) {
  return choices
    .filter((choice) => choiceState(choice) === "arriving")
    .map((choice) => choice.id);
}

function withKnownTitles(next: SyncChoice[], previous: SyncChoice[]) {
  const titles = new Map(previous.map((choice) => [choice.id, choice.title]));

  return next.map((choice) => ({
    ...choice,
    title: choice.title ?? titles.get(choice.id) ?? null,
  }));
}

export function useSyncBooks(props: SyncPanelProps, account: SyncAccount) {
  const { book, t } = props;
  const [choices, setChoices] = useState<SyncChoice[]>([]),
    [pending, setPending] = useState<ReadonlySet<string>>(new Set()),
    [problem, setProblem] = useState("");
  const signedIn = Boolean(account.info);

  function mark(ids: string[], busy: boolean) {
    setPending((current) => {
      const next = new Set(current);

      for (const id of ids) {
        if (busy) next.add(id);
        else next.delete(id);
      }

      return next;
    });
  }

  async function showKnown() {
    const known = await loadChoices(false);

    setChoices((previous) => withKnownTitles(known, previous));
  }

  async function syncOthers() {
    const arrived = await command<string[]>("sync_others", { open: book.id });

    await showKnown();
    if (arrived.length) await props.reloadBooks();
  }

  async function showLatest() {
    const latest = await loadChoices(true);
    const arriving = arrivingIds(latest);

    setChoices(latest);
    if (!arriving.length) return;
    mark(arriving, true);

    try {
      await syncOthers();
    } finally {
      mark(arriving, false);
    }
  }

  async function refresh() {
    setProblem("");

    try {
      await showKnown();
      await showLatest();
    } catch (error) {
      setProblem(readableError(error, t));
    }
  }

  useEffect(() => {
    if (signedIn) void refresh();
    else setChoices([]);
  }, [signedIn]);

  function nameOf(choice: SyncChoice) {
    return choice.title || t("untitled");
  }

  async function confirmUpload(choice: SyncChoice) {
    const answer = await props.ask(
      t("uploadBookQuestion").replace("{name}", nameOf(choice)),
      undefined,
      { detail: t("uploadBookDetail"), action: t("sync") },
    );

    return answer !== null;
  }

  async function confirmRemoval(choice: SyncChoice) {
    const answer = await props.ask(
      t("removeBookQuestion").replace("{name}", nameOf(choice)),
      undefined,
      {
        detail: t("removeBookDetail"),
        action: t("removeFromServer"),
        danger: true,
      },
    );

    return answer !== null;
  }

  async function syncOne(choice: SyncChoice) {
    if (choice.id === book.id) return account.syncInto(book.id);
    await command("sync_now", { space: choice.id });
    if (!choice.local) await props.reloadBooks();
  }

  async function include(choice: SyncChoice) {
    await command("exclude_space", { space: choice.id, excluded: false });
    if (!choice.remote) await command("remote_spaces", { link: choice.id });
    await syncOne(choice);
  }

  async function exclude(choice: SyncChoice) {
    await command("exclude_space", { space: choice.id, excluded: true });
    if (choice.id === book.id) props.setStatus(SYNC_OFF);
  }

  async function changeChoice(
    choice: SyncChoice,
    work: () => Promise<void>,
    explain = (error: unknown) => readableError(error, t),
  ) {
    mark([choice.id], true);
    setProblem("");

    try {
      await work();
    } catch (error) {
      setProblem(explain(error));
    } finally {
      await showKnown().catch(() => {});
      mark([choice.id], false);
    }
  }

  async function toggle(choice: SyncChoice) {
    if (!choice.remote && !(await confirmUpload(choice))) return;
    await changeChoice(choice, () =>
      syncsHere(choice) ? exclude(choice) : include(choice),
    );
  }

  async function removeFromServer(choice: SyncChoice) {
    await command("remove_space", { space: choice.id });
    if (choice.id === book.id) props.setStatus(SYNC_OFF);
  }

  function notRemoved(choice: SyncChoice, error: unknown) {
    const failed = t("removeBookFailed").replace("{name}", nameOf(choice));

    return failed + " " + readableError(error, t);
  }

  async function remove(choice: SyncChoice) {
    if (!(await confirmRemoval(choice))) return;
    await changeChoice(
      choice,
      () => removeFromServer(choice),
      (error) => notRemoved(choice, error),
    );
  }

  async function syncOpen() {
    if (!(await command("account_info", { space: book.id }))) return true;

    try {
      await account.syncInto(book.id);

      return true;
    } catch {
      return false;
    }
  }

  async function syncAll() {
    account.setBusy(true);
    account.fail("");
    setProblem("");

    try {
      if (await syncOpen()) await syncOthers();
    } catch (error) {
      setProblem(readableError(error, t));
    } finally {
      account.setBusy(false);
    }
  }

  return { choices, pending, problem, toggle, remove, syncAll };
}

export type SyncBooks = ReturnType<typeof useSyncBooks>;
