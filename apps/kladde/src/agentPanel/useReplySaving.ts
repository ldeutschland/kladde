import { useRef } from "react";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { AgentRun } from "../ai/AgentRun";
import { storedThread, type ChatToStore } from "./chatStore";
import { rememberReply } from "./memoryMarks";
import type { ChatThread } from "./useChatThread";

export interface FinishedChat extends ChatToStore {
  answer: string;
  remember: boolean;
}

export function useReplySaving(book: Notebook, t: T, chat: ChatThread) {
  const memoryJob = useRef<Promise<void> | null>(null),
    savedChat = useRef<Promise<string> | null>(null);

  async function remember(finished: FinishedChat, chatId: string) {
    const { question, answer, items } = finished;
    const mark = await rememberReply(book, t, question, answer);

    if (mark) {
      await chat.patchReply(chatId, items.length - 1, { memory: mark });

      return;
    }

    chat.dropSavingMemory(chatId);
  }

  async function save(finished: FinishedChat) {
    savedChat.current = chat.save(finished);
    const savedId = await savedChat.current;

    if (finished.remember) memoryJob.current = remember(finished, savedId);
  }

  async function recordApplied(task: AgentRun) {
    const changes = task.appliedChanges();
    const chatId = await savedChat.current;

    if (!chatId || !changes.length) return;
    const stored = await storedThread(book, chatId);

    await chat.patchReply(chatId, stored.length - 1, {
      changes,
      undone: false,
    });
  }

  return {
    save,
    recordApplied,
    pendingMemory: () => memoryJob.current,
  };
}

export type ReplySaving = ReturnType<typeof useReplySaving>;
