import { useEffect, useState } from "react";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { Ask } from "../ui/dialog";
import { loadChoices, syncsHere, type SyncChoice } from "../sync/useSyncBooks";
import { deleteBook, renameBook } from "./bookActions";

export interface BooksPanelActions {
  close: () => void;
  open: (id: string) => void;
  create: () => void;
  changeBook: (id?: string) => Promise<void>;
  reloadBooks: () => Promise<void>;
  notify: (text: string) => void;
}

export interface BooksPanelProps {
  book: Notebook;
  books: [string, string][];
  t: T;
  ask: Ask;
  actions: BooksPanelActions;
}

function useSyncChoices() {
  const [choices, setChoices] = useState<SyncChoice[]>([]);

  useEffect(() => {
    let current = true;

    loadChoices(false)
      .then((loaded) => current && setChoices(loaded))
      .catch(() => current && setChoices([]));

    return () => {
      current = false;
    };
  }, []);

  return choices;
}

export function useBookManager(props: BooksPanelProps) {
  const { book, books, t, ask, actions } = props;
  const choices = useSyncChoices();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const nameOf = (id: string) =>
    books.find(([key]) => key === id)?.[1] || t("untitled");
  const choiceOf = (id: string) => choices.find((choice) => choice.id === id);

  async function rename(id: string) {
    const answer = await ask(t("renameBook"), nameOf(id), {
      placeholder: t("workspaceName"),
      action: t("rename"),
    });

    if (answer === null) return;
    setProblem("");

    try {
      if (await renameBook(book, id, answer)) await actions.reloadBooks();
    } catch (error) {
      setProblem(String(error));
    }
  }

  async function remove(id: string, fromServer: boolean) {
    const choice = choiceOf(id);
    const next = books.find(([key]) => key !== id)?.[0];
    const name = nameOf(id);

    await deleteBook(book, {
      id,
      fromServer,
      syncsHere: !!choice && syncsHere(choice),
    });
    setDeleting(null);
    if (id === book.id) return actions.changeBook(next);
    actions.notify(t("bookDeleted").replace("{name}", name));
    await actions.reloadBooks();
  }

  return {
    deleting,
    setDeleting,
    problem,
    nameOf,
    choiceOf,
    rename,
    remove,
  };
}

export type BookManager = ReturnType<typeof useBookManager>;
