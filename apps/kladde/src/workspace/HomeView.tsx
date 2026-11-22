import { useMemo, type ReactNode, type RefObject } from "react";
import {
  ArrowUp,
  Camera,
  Clock,
  FilePlus,
  Mic,
  Scissors,
  Sparkles,
  SquarePen,
  Table2,
} from "lucide-react";
import type { Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { RootTab } from "../platform/chrome";
import { useAiOn } from "../ai/aiSwitch";
import { PageIcon } from "./tree";
import { startPageDrag } from "../ui/dragDrop";
import { viewKey } from "./viewMemory";
import { since } from "./since";
import { wantsNewTab } from "./PageButton";
import { SharedBadge } from "./Sidebar";
import type { PageDrops } from "./usePageDrops";
import type { PageLink } from "./types";

const RECENT_COUNT = 12;
const ASK_LENGTH = 8192;

function greeting(t: T) {
  const hour = new Date().getHours();

  return hour < 12 ? t("morning") : hour < 18 ? t("afternoon") : t("evening");
}

function coverTone(page: Page) {
  return page.cover && !page.cover.startsWith("kladde-file:")
    ? page.cover
    : undefined;
}

export function RootView({
  viewRef,
  tab,
  pagesShown,
  t,
  drop,
  children,
}: {
  viewRef: RefObject<HTMLElement | null>;
  tab: RootTab;
  pagesShown: boolean;
  t: T;
  drop: PageDrops["home"];
  children: ReactNode;
}) {
  const homeProps = pagesShown
    ? {}
    : { "data-drop-label": t("dropToImport"), ...drop };

  return (
    <article
      className={pagesShown ? "pagesview" : "home"}
      ref={viewRef}
      data-view={viewKey(null, tab)}
      {...homeProps}
    >
      {children}
    </article>
  );
}

function AskBox({
  t,
  ready,
  setReady,
  askAi,
}: {
  t: T;
  ready: boolean;
  setReady: (ready: boolean) => void;
  askAi: (text: string) => void;
}) {
  return (
    <form
      className="askbox"
      onSubmit={(e) => {
        e.preventDefault();
        const text = String(
          new FormData(e.currentTarget).get("ask") ?? "",
        ).trim();

        if (!text) return;
        e.currentTarget.reset();
        setReady(false);
        askAi(text);
      }}
    >
      <Sparkles />
      <input
        name="ask"
        aria-label={t("askAnything")}
        placeholder={t("askAnything")}
        maxLength={ASK_LENGTH}
        autoComplete="off"
        onChange={(e) => setReady(!!e.target.value.trim())}
      />
      <button className="send" aria-label={t("send")} disabled={!ready}>
        <ArrowUp />
      </button>
    </form>
  );
}

export interface QuickActions {
  page: () => void;
  database: () => void;
  capture: () => void;
  voice: () => void;
  clipWeb: () => void;
  photo: () => void;
}

function QuickButtons({
  t,
  mobile,
  shared,
  actions,
}: {
  t: T;
  mobile: boolean;
  shared: number;
  actions: QuickActions;
}) {
  return (
    <div className="quick">
      <button onClick={actions.page}>
        <FilePlus />
        {t("newPage")}
      </button>
      <button onClick={actions.database}>
        <Table2 />
        {t("newDb")}
      </button>
      <button onClick={actions.capture}>
        <SquarePen />
        {t("quickNote")}
        <SharedBadge count={shared} mobile={mobile} />
      </button>
      <button onClick={actions.voice}>
        <Mic />
        {t("voiceNote")}
      </button>
      <button onClick={actions.clipWeb}>
        <Scissors />
        {t("webClip")}
      </button>
      {mobile && (
        <button onClick={actions.photo}>
          <Camera />
          {t("photo")}
        </button>
      )}
    </div>
  );
}

function RecentCard({
  book,
  page,
  t,
  lang,
  link,
}: {
  book: Notebook;
  page: Page;
  t: T;
  lang: string;
  link: PageLink;
}) {
  return (
    <button
      className="card"
      draggable
      onDragStart={(e) => startPageDrag(e, page, page.title || t("untitled"))}
      onClick={(e) => link.go(page.id, wantsNewTab(e))}
      onAuxClick={(e) => {
        if (e.button === 1) link.go(page.id, true);
      }}
      onContextMenu={link.menu(page.id)}
    >
      <span className="cardcover" data-tone={coverTone(page)} />
      <PageIcon page={page} />
      <span className="cardtitle">{page.title || t("untitled")}</span>
      <small>{since(book.editedAt(page), lang, t)}</small>
    </button>
  );
}

function recentPages(book: Notebook, all: Page[]) {
  return all
    .filter((p) => !p.archived && p.kind !== "chat" && p.kind !== "row")
    .sort((a, b) => book.editedAt(b) - book.editedAt(a))
    .slice(0, RECENT_COUNT);
}

export function HomeContent({
  book,
  all,
  t,
  lang,
  mobile,
  link,
  shared,
  askReady,
  setAskReady,
  askAi,
  actions,
}: {
  book: Notebook;
  all: Page[];
  t: T;
  lang: string;
  mobile: boolean;
  link: PageLink;
  shared: number;
  askReady: boolean;
  setAskReady: (ready: boolean) => void;
  askAi: (text: string) => void;
  actions: QuickActions;
}) {
  const recent = useMemo(() => recentPages(book, all), [all, book]);
  const aiOn = useAiOn();
  const bookName = String(book.manifest.doc.getMap("meta").get("title"));

  return (
    <>
      <p className="greeting">{greeting(t)}</p>
      <h1>{bookName}</h1>
      {aiOn && (
        <AskBox t={t} ready={askReady} setReady={setAskReady} askAi={askAi} />
      )}
      <QuickButtons t={t} mobile={mobile} shared={shared} actions={actions} />
      {recent.length > 0 && (
        <>
          <h3 className="sectionlabel">
            <Clock />
            {t("recent")}
          </h3>
          <div className="recents">
            {recent.map((p) => (
              <RecentCard
                key={p.id}
                book={book}
                page={p}
                t={t}
                lang={lang}
                link={link}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}
