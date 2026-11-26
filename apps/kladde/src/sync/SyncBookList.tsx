import { CloudOff, LoaderCircle } from "lucide-react";
import type { T, Word } from "../locale/locale";
import { firstLetter } from "../workspace/commands";
import {
  choiceState,
  removable,
  syncsHere,
  type ChoiceState,
  type SyncBooks,
  type SyncChoice,
} from "./useSyncBooks";

const STATE_TEXT: Record<ChoiceState, Word> = {
  synced: "synced",
  arriving: "bookArriving",
  local: "unsynced",
  excludedHere: "bookExcludedHere",
  excludedAway: "bookExcludedAway",
};

interface RowProps {
  choice: SyncChoice;
  open: boolean;
  pending: boolean;
  locked: boolean;
  t: T;
  toggle: (choice: SyncChoice) => void;
  remove: (choice: SyncChoice) => void;
}

function bookName(choice: SyncChoice, t: T) {
  if (choice.title === null) return t("bookOnServer");

  return choice.title || t("untitled");
}

function stateText({ choice, open, pending, t }: RowProps) {
  const state = pending ? t("syncing") : t(STATE_TEXT[choiceState(choice)]);

  return open ? state + " · " + t("bookOpen") : state;
}

function RemoveButton(props: RowProps & { name: string }) {
  const { choice, name, pending, locked, t, remove } = props;

  if (!removable(choice)) return null;

  return (
    <button
      className="syncbookremove"
      aria-label={t("removeBookLabel").replace("{name}", name)}
      title={t("removeFromServer")}
      disabled={pending || locked}
      onClick={() => remove(choice)}
    >
      <CloudOff aria-hidden />
    </button>
  );
}

function BookRow(props: RowProps) {
  const { choice, pending, locked, t, toggle } = props;
  const name = bookName(choice, t);

  return (
    <li className={"syncbook " + choiceState(choice)}>
      <span className="avatar">{firstLetter(name)}</span>
      <span className="grow syncbookname">
        <strong>{name}</strong>
        <small>{stateText(props)}</small>
      </span>
      {pending && <LoaderCircle className="spin" aria-hidden />}
      <RemoveButton {...props} name={name} />
      <button
        className="switchitem"
        aria-pressed={syncsHere(choice)}
        aria-label={t("syncBookLabel").replace("{name}", name)}
        disabled={pending || locked}
        onClick={() => toggle(choice)}
      >
        <span className="switch" />
      </button>
    </li>
  );
}

export function SyncBookList({
  books,
  open,
  locked,
  t,
}: {
  books: SyncBooks;
  open: string;
  locked: boolean;
  t: T;
}) {
  return (
    <section className="syncbooks">
      <h3>{t("syncBooks")}</h3>
      <p className="muted">{t("syncBooksHint")}</p>
      {books.choices.length > 0 && (
        <ul>
          {books.choices.map((choice) => (
            <BookRow
              key={choice.id}
              choice={choice}
              open={choice.id === open}
              pending={books.pending.has(choice.id)}
              locked={locked}
              t={t}
              toggle={(next) => void books.toggle(next)}
              remove={(next) => void books.remove(next)}
            />
          ))}
        </ul>
      )}
      {books.problem && (
        <p className="formerror" role="alert">
          {books.problem}
        </p>
      )}
    </section>
  );
}
