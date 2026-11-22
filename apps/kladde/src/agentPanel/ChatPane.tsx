import type { Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { Policy } from "../ai/assistant";
import type { SearchHit } from "../search/search";
import { AiAnswer, type AnswerActions } from "./AiAnswer";
import { AiWelcome } from "./ChatViews";
import { Composer } from "./Composer";
import { hasAppliedChanges } from "./types";
import type { ChatThread } from "./useChatThread";
import type { AgentRunState } from "./useAgentRun";
import type { ComposerDraft } from "./useComposerDraft";
import type { PageAttachments } from "./usePageAttachments";
import type { ChatTemplates } from "./useChatTemplates";
import type { WebSearch } from "./useWebSearch";
import type { ReplyUndo } from "./useReplyUndo";
import type { ReplyActions } from "./useReplyActions";
import type { ReplySaving } from "./useReplySaving";
import type { AgentRequests } from "./useAgentRequests";

export interface PageInView {
  openPage: Page | undefined;
  excluded: boolean;
  context: Page | undefined;
  canInsert: boolean;
}

export interface ChatPaneProps {
  book: Notebook;
  t: T;
  policy: Policy;
  mode: string;
  page: PageInView;
  chat: ChatThread;
  agent: AgentRunState;
  requests: AgentRequests;
  composer: ComposerDraft;
  attachments: PageAttachments;
  templates: ChatTemplates;
  web: WebSearch;
  undo: ReplyUndo;
  replies: ReplyActions;
  saving: ReplySaving;
  applyTemplate: (id: string) => void;
  setUp: () => void;
  open: (id: string) => void;
  openSource: (hit: SearchHit) => void;
}

function answerActions(props: ChatPaneProps): AnswerActions {
  const { agent, undo, replies } = props;

  return {
    open: props.open,
    openSource: props.openSource,
    retry: props.requests.retry,
    copy: (text, index) => void replies.copy(text, index),
    insert: replies.insert,
    saveAsPage: (text, question) => void replies.saveAsPage(text, question),
    undo: (index) => void undo.undoReply(index, agent),
    webError: props.web.setError,
    changed: undo.repaint,
    applied: props.saving.recordApplied,
  };
}

function ThreadItems(props: ChatPaneProps) {
  const { book, t, chat, agent, undo } = props;
  const { thread } = chat;
  const actions = answerActions(props);

  return thread.map((item, index) => {
    if (item.role === "user")
      return (
        <div className="aiuser" key={index}>
          {item.text}
        </div>
      );
    const last = index === thread.length - 1;

    return (
      <AiAnswer
        key={index}
        book={book}
        item={item}
        t={t}
        state={{
          index,
          question: thread[index - 1]?.text ?? "",
          last,
          working: agent.busy && last,
          retriable: last && !hasAppliedChanges(item),
          copied: props.replies.copied === index,
          canInsert: props.page.canInsert,
          locked: agent.busy || undo.undoing >= 0,
          undoNote: undo.note?.index === index ? undo.note.text : "",
          review: last && !agent.busy ? agent.run : null,
        }}
        actions={actions}
      />
    );
  });
}

function ChatComposer(props: ChatPaneProps) {
  const { chat, agent, composer, attachments, templates, web } = props;

  return (
    <Composer
      book={props.book}
      t={props.t}
      policy={props.policy}
      mode={props.mode}
      busy={agent.busy}
      draft={composer.draft}
      input={composer.input}
      typeDraft={attachments.typeDraft}
      submit={() => void agent.send(composer.draft, chat.thread, chat.chat)}
      stop={agent.stop}
      template={templates.active}
      clearTemplate={templates.clear}
      templates={templates.templates}
      templateMenu={templates.templateMenu}
      setTemplateMenu={templates.setTemplateMenu}
      applyTemplate={props.applyTemplate}
      showLibrary={templates.showLibrary}
      openExcluded={props.page.excluded}
      pageContext={props.page.context}
      attached={attachments.attached}
      detach={attachments.detach}
      attachPage={attachments.attachPage}
      picking={attachments.picking}
      setPicking={attachments.setPicking}
      closePicker={attachments.closePicker}
      pickQuery={attachments.pickQuery}
      setPickQuery={attachments.setPickQuery}
      pickable={attachments.pickable}
      webSaving={web.saving}
      webError={web.error}
      toggleWeb={() => void web.toggle(agent.stop)}
    />
  );
}

export function ChatPane(props: ChatPaneProps) {
  const { t, chat, composer } = props;

  return (
    <>
      <div className="aithread" ref={chat.scroller}>
        {chat.thread.length === 0 && (
          <AiWelcome
            t={t}
            hasModel={!!props.policy.model}
            hasPage={!!props.page.context}
            templates={props.templates.templates}
            setUp={props.setUp}
            sendAboutPage={props.requests.sendAboutPage}
            prefill={(word) => composer.prefill(t(word))}
            applyTemplate={props.applyTemplate}
          />
        )}
        <ThreadItems {...props} />
      </div>
      <ChatComposer {...props} />
    </>
  );
}
