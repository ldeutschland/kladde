import { useState } from "react";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import type { T, Word } from "../locale/locale";
import { Panel } from "../ui/dialog";
import { choiceWord, removable, type SyncChoice } from "../sync/useSyncBooks";
import { deletionProblem } from "./bookActions";
import { firstLetter } from "./commands";
import {
  useBookManager,
  type BookManager,
  type BooksPanelProps,
} from "./useBookManager";

function serverNote(choice: SyncChoice, fromServer: boolean): Word {
  if (choice.primary) return "deleteBookPrimaryStays";

  return fromServer ? "deleteBookOthersKeep" : "deleteBookStays";
}

function ServerChoice({
  choice,
  fromServer,
  busy,
  t,
  toggle,
}: {
  choice: SyncChoice | undefined;
  fromServer: boolean;
  busy: boolean;
  t: T;
  toggle: () => void;
}) {
  if (!choice?.remote) return null;

  return (
    <>
      {removable(choice) && (
        <button
          type="button"
          className="switchitem"
          aria-pressed={fromServer}
          disabled={busy}
          onClick={toggle}
        >
          {t("deleteBookFromServer")}
          <span className="switch" />
        </button>
      )}
      <p className="askdetail">{t(serverNote(choice, fromServer))}</p>
    </>
  );
}

function DeleteBookPanel({
  id,
  manager,
  t,
}: {
  id: string;
  manager: BookManager;
  t: T;
}) {
  const name = manager.nameOf(id);
  const choice = manager.choiceOf(id);
  const offersServer = !!choice && removable(choice);
  const [fromServer, setFromServer] = useState(offersServer);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const close = () => manager.setDeleting(null);

  async function confirm() {
    setBusy(true);
    setProblem("");

    try {
      await manager.remove(id, offersServer && fromServer);
    } catch (error) {
      setProblem(deletionProblem(error, name, t));
      setBusy(false);
    }
  }

  return (
    <Panel
      title={t("deleteBookQuestion").replace("{name}", name)}
      t={t}
      close={close}
      className="ask deletebook"
      keep={busy}
    >
      <p className="askdetail">{t("deleteBookDetail")}</p>
      <ServerChoice
        choice={choice}
        fromServer={fromServer}
        busy={busy}
        t={t}
        toggle={() => setFromServer(!fromServer)}
      />
      {problem && (
        <p className="formerror" role="alert">
          {problem}
        </p>
      )}
      <footer>
        <button type="button" disabled={busy} onClick={close}>
          {t("cancel")}
        </button>
        <button
          type="button"
          className="dangerbutton"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy ? t("deleting") : t("deleteBook")}
        </button>
      </footer>
    </Panel>
  );
}

function BookRow({
  id,
  name,
  current,
  only,
  manager,
  open,
  t,
}: {
  id: string;
  name: string;
  current: boolean;
  only: boolean;
  manager: BookManager;
  open: (id: string) => void;
  t: T;
}) {
  const choice = manager.choiceOf(id);
  const shown = name || t("untitled");

  return (
    <li className="bookrow">
      <button
        className="grow bookopen"
        aria-current={current ? "true" : undefined}
        disabled={current}
        onClick={() => open(id)}
      >
        <span className="avatar">{firstLetter(shown)}</span>
        <span className="grow bookname">
          <strong>{shown}</strong>
          {choice && <small>{t(choiceWord(choice))}</small>}
        </span>
        {current && <Check />}
      </button>
      <button
        className="bookaction"
        title={t("rename")}
        aria-label={t("renameBookLabel").replace("{name}", shown)}
        onClick={() => void manager.rename(id)}
      >
        <Pencil />
      </button>
      <button
        className="bookaction bookdelete"
        title={t("deleteBook")}
        aria-label={t("deleteBookLabel").replace("{name}", shown)}
        disabled={only}
        onClick={() => manager.setDeleting(id)}
      >
        <Trash2 />
      </button>
    </li>
  );
}

export function BooksPanel(props: BooksPanelProps) {
  const { book, books, t, actions } = props;
  const manager = useBookManager(props);
  const only = books.length < 2;

  return (
    <Panel
      title={t("manageBooks")}
      t={t}
      close={actions.close}
      className="bookspanel"
    >
      <ul className="booklist">
        {books.map(([id, name]) => (
          <BookRow
            key={id}
            id={id}
            name={name}
            current={id === book.id}
            only={only}
            manager={manager}
            open={actions.open}
            t={t}
          />
        ))}
      </ul>
      {only && <p className="muted bookhint">{t("deleteBookLast")}</p>}
      {manager.problem && (
        <p className="formerror" role="alert">
          {manager.problem}
        </p>
      )}
      <footer>
        <button onClick={actions.create}>
          <Plus />
          {t("newBook")}
        </button>
      </footer>
      {manager.deleting && (
        <DeleteBookPanel id={manager.deleting} manager={manager} t={t} />
      )}
    </Panel>
  );
}
