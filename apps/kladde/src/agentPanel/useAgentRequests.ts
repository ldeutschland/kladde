import { useEffect } from "react";
import type { Page } from "../notebook/notebook";
import type { T, Word } from "../locale/locale";
import { hasAppliedChanges } from "./types";
import type { AgentRunState } from "./useAgentRun";
import type { ChatThread } from "./useChatThread";
import type { ComposerDraft } from "./useComposerDraft";
import type { PageAttachments } from "./usePageAttachments";

interface RequestOptions {
  t: T;
  prompt: string;
  clearPrompt: () => void;
  pageContext: Page | undefined;
  agent: AgentRunState;
  chat: ChatThread;
  composer: ComposerDraft;
  attachments: PageAttachments;
}

export function useAgentRequests(options: RequestOptions) {
  const { agent, chat, attachments } = options;

  useEffect(() => {
    if (!options.prompt) return;
    options.clearPrompt();
    if (agent.ready && !agent.busy) void agent.send(options.prompt, [], null);
    else options.composer.setDraft(options.prompt);
  }, [options.prompt]);

  function retry() {
    const { thread } = chat;
    const question = thread[thread.length - 2];
    const answer = thread[thread.length - 1];

    if (!question || question.role !== "user") return;
    if (answer && hasAppliedChanges(answer)) return;
    void agent.send(question.text, thread.slice(0, -2), chat.chat);
  }

  function sendAboutPage(word: Word) {
    const page = options.pageContext;

    if (!page) return;
    const pages = attachments.attached.includes(page.id)
      ? attachments.attached
      : [...attachments.attached, page.id];

    attachments.setAttached(pages);
    void agent.send(options.t(word), [], chat.chat, pages);
  }

  return { retry, sendAboutPage };
}

export type AgentRequests = ReturnType<typeof useAgentRequests>;
