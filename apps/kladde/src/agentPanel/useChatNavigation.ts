import { useEffect } from "react";
import type { Notebook } from "../notebook/notebook";
import type { AiView } from "./types";
import type { ChatThread } from "./useChatThread";
import type { ComposerDraft } from "./useComposerDraft";
import type { PageAttachments } from "./usePageAttachments";
import type { ChatTemplates } from "./useChatTemplates";
import type { ReplyUndo } from "./useReplyUndo";
import type { AgentRunState } from "./useAgentRun";

interface NavigationOptions {
  book: Notebook;
  prompt: string;
  setView: (view: AiView) => void;
  chat: ChatThread;
  agent: AgentRunState;
  undo: ReplyUndo;
  composer: ComposerDraft;
  attachments: PageAttachments;
  templates: ChatTemplates;
}

export function useChatNavigation(options: NavigationOptions) {
  const { book, chat, agent, undo, composer, attachments, templates } = options;

  useEffect(() => {
    const last = book.settings.get("lastChat");

    if (typeof last === "string" && !options.prompt) void showChat(last);
  }, [book]);

  async function showChat(id: string) {
    const saved = await chat.show(id);

    if (!saved) return;
    agent.forget();
    undo.clearNote();
    attachments.clear();
    templates.select(saved.template);
    options.setView("chat");
  }

  function newChat() {
    if (agent.busy) return;
    chat.clear();
    agent.forget();
    undo.clearNote();
    composer.setDraft("");
    attachments.clear();
    templates.clear();
    options.setView("chat");
    book.settings.delete("lastChat");
    composer.focus();
  }

  return { showChat, newChat };
}
