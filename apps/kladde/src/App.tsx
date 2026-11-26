import { Suspense, useCallback, useEffect, useState } from "react";
import { BookOpen, LoaderCircle } from "lucide-react";
import { Notebook } from "./notebook/notebook";
import { command } from "./platform/native";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { deviceLanguage, translator, type T } from "./locale/locale";
import { Panel } from "./ui/dialog";
import { ContextMenuHost } from "./ui/ContextMenu";
import { Workspace } from "./workspace/Workspace";

async function startingBook(list: [string, string][]) {
  const opened = await command<string | null>("opened_space");
  const known = list.some(([id]) => id === opened);

  return known ? opened : list[0]?.[0];
}

function Loading({ label }: { label: string }) {
  return (
    <main className="welcome loading" aria-busy="true">
      <div>
        <div className="mark">
          <BookOpen />
        </div>
        <LoaderCircle className="spin" role="status" aria-label={label} />
      </div>
    </main>
  );
}

function StartScreen({
  ready,
  t,
  start,
}: {
  ready: boolean;
  t: T;
  start: (sync: boolean) => void;
}) {
  if (!ready) return <Loading label={t("loading")} />;

  return (
    <main className="welcome">
      <div>
        <div className="mark">
          <BookOpen />
        </div>
        <h1>{t("welcome")}</h1>
        <p>{t("intro")}</p>
        <div className="welcomeactions">
          <button className="primary" onClick={() => start(false)}>
            {t("local")}
          </button>
          <button onClick={() => start(true)}>{t("connect")}</button>
        </div>
      </div>
    </main>
  );
}

type BookList = [string, string][];
type Setter<Value> = (value: Value) => void;

function useStartup(
  refresh: () => Promise<void>,
  setPlatform: Setter<string>,
  setError: Setter<string>,
) {
  useEffect(() => {
    void command<string>("platform")
      .then(setPlatform)
      .catch((error) => setError(String(error)));
    void refresh().catch((error) => setError(String(error)));

    const report = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      setError(String(event.reason));
    };

    window.addEventListener("unhandledrejection", report);

    return () => window.removeEventListener("unhandledrejection", report);
  }, [refresh]);
}

function useAppSession() {
  const [platform, setPlatform] = useState("macos");
  const [books, setBooks] = useState<BookList>([]);
  const [book, setBook] = useState<Notebook | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [account, setAccount] = useState(false);
  const refresh = useCallback(async (id?: string) => {
    setReady(false);
    const list = await command<BookList>("spaces");

    setBooks(list);
    const target = id ?? (await startingBook(list));

    if (target) setBook(await Notebook.open(target));
    if (id) await command("remember_space", { id });
    setReady(true);
  }, []);
  const reloadBooks = useCallback(async () => {
    setBooks(await command<BookList>("spaces"));
  }, []);

  useStartup(refresh, setPlatform, setError);

  async function start(sync: boolean, title: string) {
    const created = await Notebook.create(title);

    setBooks(await command("spaces"));
    setBook(created);
    setAccount(sync);
  }

  return {
    platform,
    books,
    book,
    ready,
    error,
    setError,
    account,
    refresh,
    reloadBooks,
    start,
  };
}

type Session = ReturnType<typeof useAppSession>;

function FailedWorkspace({ t }: { t: T }) {
  return (
    <main className="welcome">
      <div className="emptystate">
        <p>{t("appFailed")}</p>
        <button className="primary" onClick={() => location.reload()}>
          {t("retry")}
        </button>
      </div>
    </main>
  );
}

function OpenWorkspace({
  book,
  session,
  t,
}: {
  book: Notebook;
  session: Session;
  t: T;
}) {
  return (
    <ErrorBoundary key={book.id} fallback={<FailedWorkspace t={t} />}>
      <Suspense fallback={<Loading label={t("loading")} />}>
        <Workspace
          key={book.id}
          book={book}
          mobile={session.platform === "ios"}
          books={session.books}
          changeBook={session.refresh}
          reloadBooks={session.reloadBooks}
          initialSync={session.account}
        />
      </Suspense>
    </ErrorBoundary>
  );
}

function ErrorPanel({ session, t }: { session: Session; t: T }) {
  return (
    <Panel t={t} title={t("err")} close={() => session.setError("")}>
      <p role="alert">{session.error}</p>
      <footer>
        <button
          className="primary"
          onClick={() => {
            session.setError("");
            void session.refresh();
          }}
        >
          {t("retry")}
        </button>
      </footer>
    </Panel>
  );
}

export function App() {
  const session = useAppSession();
  const { book } = session;
  const t = translator(deviceLanguage());

  return (
    <>
      {book ? (
        <OpenWorkspace book={book} session={session} t={t} />
      ) : (
        <StartScreen
          ready={session.ready}
          t={t}
          start={(sync) => void session.start(sync, t("firstBook"))}
        />
      )}
      {!book && <ContextMenuHost t={t} />}
      {session.error && <ErrorPanel session={session} t={t} />}
    </>
  );
}
