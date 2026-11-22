import {
  BookMarked,
  Clock,
  FileText,
  Languages,
  LayoutTemplate,
  Lightbulb,
  ListChecks,
  MessageSquare,
  PenLine,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import type { Notebook, Page } from "../notebook/notebook";
import type { T, Word } from "../locale/locale";
import type { AiView } from "./types";
import { useAiOn } from "../ai/aiSwitch";

const SUGGESTED_TEMPLATES = 6;

export function AiHeader({
  title,
  view,
  busy,
  t,
  newChat,
  setView,
  close,
}: {
  title: string;
  view: AiView;
  busy: boolean;
  t: T;
  newChat: () => void;
  setView: (view: AiView) => void;
  close: () => void;
}) {
  const toggle = (target: AiView) => setView(view === target ? "chat" : target);
  const aiOn = useAiOn();

  return (
    <header>
      <span className="aiheading">
        <Sparkles />
        {title}
      </span>
      {aiOn && (
        <>
          <button
            aria-label={t("newChat")}
            title={t("newChat")}
            disabled={busy}
            onClick={newChat}
          >
            <SquarePen />
          </button>
          <button
            aria-label={t("aiLibrary")}
            title={t("aiLibrary")}
            aria-pressed={view === "library"}
            onClick={() => toggle("library")}
          >
            <BookMarked />
          </button>
          <button
            aria-label={t("history")}
            title={t("history")}
            aria-pressed={view === "history"}
            onClick={() => toggle("history")}
          >
            <Clock />
          </button>
          <button
            aria-label={t("settings")}
            title={t("settings")}
            aria-pressed={view === "settings"}
            onClick={() => toggle("settings")}
          >
            <Settings />
          </button>
        </>
      )}
      <button aria-label={t("close")} title={t("close")} onClick={close}>
        <X />
      </button>
    </header>
  );
}

export function AiIntro({ t, enable }: { t: T; enable: () => void }) {
  return (
    <div className="aiintro">
      <span className="aiorb">
        <Sparkles />
      </span>
      <h2>{t("aiTitle")}</h2>
      <p>{t("aiIntro")}</p>
      <button className="primary" onClick={enable}>
        {t("aiEnable")}
      </button>
    </div>
  );
}

export function ChatHistory({
  book,
  chats,
  chat,
  lang,
  t,
  show,
  newChat,
}: {
  book: Notebook;
  chats: Page[];
  chat: string | null;
  lang: string;
  t: T;
  show: (id: string) => void;
  newChat: () => void;
}) {
  return (
    <div className="aihistory">
      {chats.length === 0 && <p className="muted">{t("empty")}</p>}
      {chats.map((p) => (
        <div
          className="aihistoryitem"
          key={p.id}
          data-current={p.id === chat || undefined}
        >
          <button className="grow" onClick={() => show(p.id)}>
            <MessageSquare />
            <span className="grow">{p.title || t("untitled")}</span>
            <small>{new Date(book.editedAt(p)).toLocaleDateString(lang)}</small>
          </button>
          <button
            aria-label={t("toTrash")}
            title={t("toTrash")}
            onClick={async () => {
              await book.trashBranch(p.id, Date.now());
              if (p.id === chat) newChat();
            }}
          >
            <Trash2 />
          </button>
        </div>
      ))}
    </div>
  );
}

function PageSuggestions({
  t,
  sendAboutPage,
}: {
  t: T;
  sendAboutPage: (word: Word) => void;
}) {
  return (
    <>
      <button onClick={() => sendAboutPage("sumPage")}>
        <FileText />
        {t("sumPage")}
      </button>
      <button onClick={() => sendAboutPage("tasksPage")}>
        <ListChecks />
        {t("tasksPage")}
      </button>
      <button onClick={() => sendAboutPage("translatePage")}>
        <Languages />
        {t("translatePage")}
      </button>
    </>
  );
}

export function AiWelcome({
  t,
  hasModel,
  hasPage,
  templates,
  setUp,
  sendAboutPage,
  prefill,
  applyTemplate,
}: {
  t: T;
  hasModel: boolean;
  hasPage: boolean;
  templates: Page[];
  setUp: () => void;
  sendAboutPage: (word: Word) => void;
  prefill: (word: Word) => void;
  applyTemplate: (id: string) => void;
}) {
  return (
    <div className="aiwelcome">
      <span className="aiorb">
        <Sparkles />
      </span>
      <h2>{t("aiHello")}</h2>
      {!hasModel && (
        <p className="aisetup">
          {t("aiSetup")}
          <button onClick={setUp}>{t("setUp")}</button>
        </p>
      )}
      <div className="aisuggest">
        {hasPage && <PageSuggestions t={t} sendAboutPage={sendAboutPage} />}
        <button onClick={() => prefill("findPrefix")}>
          <Search />
          {t("findInBook")}
        </button>
        <button onClick={() => prefill("draftPrefix")}>
          <PenLine />
          {t("draftText")}
        </button>
        <button onClick={() => prefill("brainstormPrefix")}>
          <Lightbulb />
          {t("brainstorm")}
        </button>
        {templates.slice(0, SUGGESTED_TEMPLATES).map((page) => (
          <button key={page.id} onClick={() => applyTemplate(page.id)}>
            <LayoutTemplate />
            {page.title || t("untitled")}
          </button>
        ))}
      </div>
    </div>
  );
}
