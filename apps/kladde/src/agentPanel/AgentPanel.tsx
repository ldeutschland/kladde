import type { BlockNoteEditor } from "@blocknote/core";
import type { Entry, Notebook } from "../notebook/notebook";
import type { Ask } from "../ui/dialog";
import type { T, Word } from "../locale/locale";
import type { SearchHit } from "../search/search";
import { savePolicy, type Policy } from "../ai/assistant";
import { aiExcluded, prepareAiHome } from "../ai/aiPages";
import { AiLibrary } from "./AiLibrary";
import { AiSettings } from "./AiSettings";
import { AiHeader, AiIntro, ChatHistory } from "./ChatViews";
import { ChatPane, type PageInView } from "./ChatPane";
import { AGENT_MODES } from "./modes";
import type { AiView } from "./types";
import { useComposerDraft } from "./useComposerDraft";
import { usePageAttachments } from "./usePageAttachments";
import { useChatTemplates } from "./useChatTemplates";
import { useWebSearch } from "./useWebSearch";
import { useChatThread } from "./useChatThread";
import { useReplyUndo } from "./useReplyUndo";
import { useReplySaving } from "./useReplySaving";
import { useAgentRun } from "./useAgentRun";
import { useChatNavigation } from "./useChatNavigation";
import { useAgentRequests } from "./useAgentRequests";
import { useReplyActions } from "./useReplyActions";

const DEFAULT_MODE = "propose";
const HISTORY_CHATS = 100;
const VIEW_TITLES: Partial<Record<AiView, Word>> = {
  history: "history",
  settings: "settings",
  library: "aiLibrary",
};

export interface AgentPanelProps {
  book: Notebook;
  current: Entry | null;
  editor: () => BlockNoteEditor | null;
  policy: Policy;
  setPolicy: (policy: Policy) => void;
  view: AiView;
  setView: (view: AiView) => void;
  prompt: string;
  clearPrompt: () => void;
  open: (id: string) => void;
  openSource: (hit: SearchHit) => void;
  close: () => void;
  ask: Ask;
  t: T;
  lang: string;
}

function storedMode(book: Notebook) {
  const stored = String(book.settings.get("agentMode") ?? DEFAULT_MODE);

  return (AGENT_MODES as readonly string[]).includes(stored)
    ? stored
    : DEFAULT_MODE;
}

function pageInView(book: Notebook, current: Entry | null): PageInView {
  const currentPage = current ? book.pages.get(current.id) : undefined;
  const openPage =
    currentPage && currentPage.kind !== "chat" ? currentPage : undefined;
  const excluded = !!openPage && aiExcluded(book, openPage.id);

  return {
    openPage,
    excluded,
    context: excluded ? undefined : openPage,
    canInsert:
      !!openPage && (openPage.kind === "page" || openPage.kind === "row"),
  };
}

function recentChats(book: Notebook) {
  return [...book.pages.values()]
    .filter((page) => page.kind === "chat" && !page.archived)
    .sort((a, b) => book.editedAt(b) - book.editedAt(a))
    .slice(0, HISTORY_CHATS);
}

function usePanelState(props: AgentPanelProps) {
  const { book, t, view, setView } = props;
  const mode = storedMode(book);
  const page = pageInView(book, props.current);
  const composer = useComposerDraft(view);
  const attachments = usePageAttachments(book, composer);
  const templates = useChatTemplates({
    book,
    t,
    setView,
    focus: composer.focus,
  });
  const web = useWebSearch(book, props.policy, props.setPolicy);
  const chat = useChatThread(book, t);
  const undo = useReplyUndo({ book, ask: props.ask, t, chat });
  const saving = useReplySaving(book, t, chat);
  const agent = useAgentRun({
    ...props,
    mode,
    pageContext: page.context,
    composer,
    attachments,
    templates,
    web,
    chat,
    undo,
    saving,
  });
  const navigation = useChatNavigation({
    ...props,
    chat,
    agent,
    undo,
    composer,
    attachments,
    templates,
  });
  const requests = useAgentRequests({
    ...props,
    pageContext: page.context,
    agent,
    chat,
    composer,
    attachments,
  });
  const replies = useReplyActions(book, props.editor, props.open);

  return {
    mode,
    page,
    composer,
    attachments,
    templates,
    web,
    chat,
    undo,
    saving,
    agent,
    navigation,
    requests,
    replies,
  };
}

export function AgentPanel(props: AgentPanelProps) {
  const { book, policy, view, setView, t } = props;
  const state = usePanelState(props);
  const { agent, navigation, templates } = state;
  const applyTemplate = (id: string) => templates.apply(id, agent.busy);

  async function enable() {
    const agreed = await props.ask(t("aiPrivacy"), undefined, {
      detail: t("aiPrivacyDetail"),
      action: t("aiEnable"),
    });

    if (!agreed) return;
    const next = { ...policy, enabled: true };

    await savePolicy(book.id, next);
    props.setPolicy(next);
    setView(next.model ? "chat" : "settings");
  }

  async function openAiHome() {
    try {
      props.open(await prepareAiHome(book, t));
    } catch (error) {
      state.web.setError(String(error));
    }
  }

  function body() {
    if (view === "settings")
      return (
        <AiSettings
          book={book}
          policy={policy}
          setPolicy={props.setPolicy}
          mode={state.mode}
          ask={props.ask}
          t={t}
          openHome={() => void openAiHome()}
        />
      );
    if (view === "library")
      return (
        <AiLibrary
          book={book}
          t={t}
          lang={props.lang}
          tab={templates.libraryTab}
          setTab={templates.setLibraryTab}
          open={props.open}
          openHome={() => void openAiHome()}
          apply={applyTemplate}
        />
      );
    if (!policy.enabled) return <AiIntro t={t} enable={() => void enable()} />;
    if (view === "history")
      return (
        <ChatHistory
          book={book}
          chats={recentChats(book)}
          chat={state.chat.chat}
          lang={props.lang}
          t={t}
          show={(id) => void navigation.showChat(id)}
          newChat={navigation.newChat}
        />
      );

    return (
      <ChatPane
        {...props}
        {...state}
        applyTemplate={applyTemplate}
        setUp={() => setView("settings")}
      />
    );
  }

  return (
    <section className="aipanel" aria-label={t("ai")}>
      <AiHeader
        title={t(VIEW_TITLES[view] ?? "aiTitle")}
        view={view}
        busy={agent.busy}
        t={t}
        newChat={navigation.newChat}
        setView={setView}
        close={props.close}
      />
      {body()}
    </section>
  );
}
