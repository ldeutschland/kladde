import { useEffect, useRef, useState, type RefObject } from "react";
import type { Entry, Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { Ask } from "../ui/dialog";
import { AgentRun } from "../ai/AgentRun";
import { memoryAuto, pageText, roleContext, ROLE_BUDGETS } from "../ai/aiPages";
import { localDate } from "../database/rules";
import { stopRun, type Policy } from "../ai/assistant";
import { runAgentLoop, type LoopOutcome } from "./agentLoop";
import { savingMark, withMemory } from "./memoryMarks";
import type { AiView, Item } from "./types";
import type { ChatThread } from "./useChatThread";
import type { ComposerDraft } from "./useComposerDraft";
import type { PageAttachments } from "./usePageAttachments";
import type { ChatTemplates } from "./useChatTemplates";
import type { WebSearch } from "./useWebSearch";
import type { ReplyUndo } from "./useReplyUndo";
import type { ReplySaving } from "./useReplySaving";

const QUESTION_LENGTH = 8192;
const SHARED_PAGES = 500;

export interface AgentRunOptions {
  book: Notebook;
  current: Entry | null;
  ask: Ask;
  t: T;
  policy: Policy;
  mode: string;
  pageContext: Page | undefined;
  setView: (view: AiView) => void;
  composer: ComposerDraft;
  attachments: PageAttachments;
  templates: ChatTemplates;
  web: WebSearch;
  chat: ChatThread;
  undo: ReplyUndo;
  saving: ReplySaving;
}

async function promptContext(options: AgentRunOptions, task: AgentRun) {
  const { book, policy, mode, templates } = options;
  const [instructions, memories, template] = await Promise.all([
    roleContext(book, "instructions"),
    roleContext(book, "memory"),
    templates.active
      ? pageText(book, templates.active.id, ROLE_BUDGETS.template)
      : null,
  ]);
  const used = [...instructions, ...memories, ...(template ? [template] : [])];

  for (const page of used) task.shared.add(page.id);

  return {
    mode,
    web: policy.web_search,
    instructions,
    memories,
    template,
    memoryAuto: memoryAuto(book),
    today: localDate(),
  };
}

function runFailure(task: AgentRun, outcome: LoopOutcome, t: T) {
  if (task.stopped) return t("runStopped");
  if (!outcome.complete && !outcome.failure) return t("runIncomplete");

  return outcome.failure;
}

function finalReply(task: AgentRun, outcome: LoopOutcome, t: T): Item {
  const failure = runFailure(task, outcome, t);

  if (task.stopped && task.mode === "propose") task.changes.clear();

  return {
    role: "assistant",
    text: outcome.answer,
    steps: [...task.trace],
    cost: outcome.cost,
    error: failure || undefined,
    sources: outcome.sources,
    citations: task.citations,
    shared: [...task.shared].slice(0, SHARED_PAGES),
    changes: task.appliedChanges(),
  };
}

interface FinishedRun {
  task: AgentRun;
  outcome: LoopOutcome;
  asked: Item[];
  chatId: string | null;
  question: string;
}

function finishedChat(options: AgentRunOptions, run: FinishedRun) {
  const { task, outcome } = run;
  const items = [...run.asked, finalReply(task, outcome, options.t)];
  const remember =
    outcome.complete && !task.stopped && memoryAuto(options.book);

  return {
    id: run.chatId,
    items,
    question: run.question,
    template: options.templates.active?.id ?? "",
    answer: outcome.answer,
    remember,
    shown: remember ? withMemory(items, savingMark()) : items,
  };
}

function createTask(options: AgentRunOptions) {
  return new AgentRun(
    options.book,
    options.pageContext ? options.current : null,
    options.mode,
    options.ask,
    options.policy.steps,
  );
}

function loopSettings(options: AgentRunOptions, task: AgentRun) {
  return {
    bookId: options.book.id,
    task,
    mode: options.mode,
    policy: options.policy,
    context: () => promptContext(options, task),
    web: options.web,
  };
}

type RunRef = RefObject<AgentRun | null>;
type ActiveRef = RefObject<string>;

function stopTask(running: RunRef, active: ActiveRef) {
  if (running.current) running.current.stopped = true;
  void stopRun(active.current);
}

function useStopOnLeave(book: Notebook, running: RunRef, active: ActiveRef) {
  useEffect(() => () => stopTask(running, active), [book]);
}

async function waitForMemory(sending: RefObject<boolean>, saving: ReplySaving) {
  sending.current = true;

  try {
    await saving.pendingMemory();
  } finally {
    sending.current = false;
  }
}

export function useAgentRun(options: AgentRunOptions) {
  const { book, policy, chat, composer, attachments } = options;
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<AgentRun | null>(null);
  const running = useRef<AgentRun | null>(null);
  const active = useRef("");
  const sending = useRef(false);
  const ready = policy.enabled && !!policy.model;

  useStopOnLeave(book, running, active);

  function blocked() {
    if (busy || options.web.saving || options.undo.undoing >= 0) return true;

    return !!running.current || sending.current;
  }

  function begin() {
    composer.setDraft("");
    setBusy(true);
    options.undo.clearNote();
    const task = createTask(options);

    running.current = task;
    setRun(task);

    return task;
  }

  async function send(
    text: string,
    history: Item[],
    chatId: string | null,
    pages: string[] = attachments.attached,
  ) {
    const question = text.trim().slice(0, QUESTION_LENGTH);

    if (!question || blocked()) return;
    await waitForMemory(sending, options.saving);

    if (!ready) {
      composer.setDraft(question);
      options.setView("settings");

      return;
    }

    const task = begin();
    const asked: Item[] = [...history, { role: "user", text: question }];
    const showReply = (reply: Item) => chat.showIfAlive([...asked, reply]);

    showReply({ role: "assistant", text: "" });
    const outcome = await runAgentLoop({
      ...loopSettings(options, task),
      question,
      history,
      pages,
      active,
      show: (answer) =>
        showReply({ role: "assistant", text: answer, steps: [...task.trace] }),
    });

    running.current = null;
    if (!chat.alive.current) return;
    const finished = finishedChat(options, {
      task,
      outcome,
      asked,
      chatId,
      question,
    });

    chat.setThread(finished.shown);
    setBusy(false);
    await options.saving.save(finished);
  }

  return {
    busy,
    run,
    ready,
    forget: () => setRun(null),
    send,
    stop: () => stopTask(running, active),
  };
}

export type AgentRunState = ReturnType<typeof useAgentRun>;
