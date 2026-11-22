import { useState } from "react";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { Ask } from "../ui/dialog";
import type { AgentRun } from "../ai/AgentRun";
import { editedSince, undoChanges, type AiChange } from "../ai/aiUndo";
import { hasAppliedChanges, type UndoNote } from "./types";
import type { ChatThread } from "./useChatThread";

interface UndoOptions {
  book: Notebook;
  ask: Ask;
  t: T;
  chat: ChatThread;
}

interface RunState {
  busy: boolean;
  run: AgentRun | null;
}

export function useReplyUndo({ book, ask, t, chat }: UndoOptions) {
  const [undoing, setUndoing] = useState(-1),
    [note, setNote] = useState<UndoNote | null>(null),
    [, paint] = useState(0);

  async function revert(changes: AiChange[], live: AgentRun | null) {
    if (live?.undos.length) {
      await live.undo();

      return [];
    }

    const edited = await editedSince(book, changes);
    const agreed =
      !edited.length ||
      (await ask(t("undoEditedQuestion"), undefined, {
        detail: t("undoEditedDetail").replace("{pages}", edited.join(", ")),
        action: t("undoShort"),
      }));

    return agreed ? undoChanges(book, changes) : null;
  }

  async function undoReply(index: number, agent: RunState) {
    const item = chat.thread[index];

    if (!chat.chat || agent.busy || undoing >= 0) return;
    if (!item || !hasAppliedChanges(item)) return;
    setUndoing(index);
    setNote(null);

    try {
      const live = index === chat.thread.length - 1 ? agent.run : null;
      const failed = await revert(item.changes ?? [], live);

      if (!failed) return;
      await chat.patchReply(chat.chat, index, { undone: true });
      if (failed.length)
        setNote({ index, text: t("undoFailed") + " " + failed.join(", ") });
    } catch (error) {
      setNote({ index, text: String(error) });
    } finally {
      setUndoing(-1);
      paint((count) => count + 1);
    }
  }

  return {
    undoing,
    note,
    clearNote: () => setNote(null),
    undoReply,
    repaint: () => paint((count) => count + 1),
  };
}

export type ReplyUndo = ReturnType<typeof useReplyUndo>;
