import { useEffect, useState } from "react";
import { command } from "../platform/native";
import { SYNC_OFF } from "./sync";
import { readableError, type SyncPanelProps } from "./accountTypes";
import type { SyncAccount } from "./useSyncAccount";

export interface SyncChoice {
  id: string;
  title: string | null;
  local: boolean;
  remote: boolean;
  excluded: boolean;
}

export type ChoiceState =
  "synced" | "arriving" | "local" | "excludedHere" | "excludedAway";

export function choiceState(choice: SyncChoice): ChoiceState {
  if (!choice.remote) return "local";
  if (!choice.excluded) return choice.local ? "synced" : "arriving";

  return choice.local ? "excludedHere" : "excludedAway";
}

export function syncsHere(choice: SyncChoice) {
  return choice.remote && !choice.excluded;
}

function loadChoices(refresh: boolean) {
  return command<SyncChoice[]>("sync_choices", { refresh });
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

  async function confirmUpload(choice: SyncChoice) {
    const name = choice.title || t("untitled");
    const answer = await props.ask(
      t("uploadBookQuestion").replace("{name}", name),
      undefined,
      { detail: t("uploadBookDetail"), action: t("sync") },
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

  async function toggle(choice: SyncChoice) {
    if (!choice.remote && !(await confirmUpload(choice))) return;
    mark([choice.id], true);
    setProblem("");

    try {
      if (syncsHere(choice)) await exclude(choice);
      else await include(choice);
    } catch (error) {
      setProblem(readableError(error, t));
    } finally {
      await showKnown().catch(() => {});
      mark([choice.id], false);
    }
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

  return { choices, pending, problem, toggle, syncAll };
}

export type SyncBooks = ReturnType<typeof useSyncBooks>;
