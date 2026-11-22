import type { RefObject } from "react";
import type { AgentRun } from "../ai/AgentRun";
import { toolsForMode } from "../ai/toolCatalog";
import {
  CONTINUE_ANSWER,
  EMPTY_ANSWER,
  FINAL_TURN,
  requestMessage,
  systemPrompt,
  type PromptContext,
} from "../ai/prompts";
import { parseArguments, type ToolCall } from "../ai/toolCalls";
import {
  startRun,
  stopRun,
  streamTurn,
  type Message,
  type Policy,
  type WebSource,
} from "../ai/assistant";
import type { Item } from "./types";

const HISTORY_ITEMS = 20;
const HISTORY_TEXT = 12000;
const HISTORY_ITEM_TEXT = 4000;
const TOOL_RESULT = 12000;
const KEPT_TOOL_RESULT = 1400;
const COMPACT_TOOL_RESULT = 1800;
const WEB_SOURCES = 24;

type Turn = Awaited<ReturnType<typeof streamTurn>>;

export interface WebSearchFlags {
  enabled: RefObject<boolean>;
  streaming: RefObject<boolean>;
}

export interface LoopRequest {
  bookId: string;
  task: AgentRun;
  mode: string;
  policy: Policy;
  question: string;
  history: Item[];
  pages: string[];
  context: () => Promise<PromptContext>;
  web: WebSearchFlags;
  active: RefObject<string>;
  show: (answer: string) => void;
}

export interface LoopOutcome {
  answer: string;
  cost: number;
  failure: string;
  complete: boolean;
  sources: WebSource[];
}

interface LoopProgress {
  answer: string;
  cost: number;
  failure: string;
  complete: boolean;
  nudged: boolean;
  sources: Map<string, WebSource>;
}

interface Conversation {
  context: PromptContext;
  messages: Message[];
  tools: unknown[];
}

function conversationContext(items: Item[]): Message[] {
  const messages: Message[] = [];
  let remaining = HISTORY_TEXT;

  for (const item of items.slice(-HISTORY_ITEMS).reverse()) {
    if (!item.text) continue;
    const content = item.text.slice(0, Math.min(HISTORY_ITEM_TEXT, remaining));

    messages.unshift({ role: item.role, content });
    remaining -= content.length;
    if (!remaining) break;
  }

  return messages;
}

function toolContent(result: unknown) {
  const text = JSON.stringify({ untrusted_notebook_data: result });

  if (text.length <= TOOL_RESULT) return text;

  return JSON.stringify({
    untrusted_notebook_data: text.slice(0, TOOL_RESULT),
    truncated: true,
  });
}

function compactToolResults(messages: Message[]) {
  for (const message of messages) {
    if (
      message.role === "tool" &&
      typeof message.content === "string" &&
      message.content.length > COMPACT_TOOL_RESULT
    )
      message.content = JSON.stringify({
        untrusted_notebook_data: message.content.slice(0, KEPT_TOOL_RESULT),
        truncated: true,
      });
  }
}

async function runTool(task: AgentRun, call: ToolCall) {
  try {
    return await task.call(
      call.function.name,
      parseArguments(call.function.arguments),
    );
  } catch (error) {
    if (task.stopped) throw error;

    return { error: String(error) };
  }
}

async function openConversation(request: LoopRequest): Promise<Conversation> {
  const context = await request.context();
  const attachedPages = await request.task.attach(request.pages);
  const messages: Message[] = [
    { role: "system", content: "" },
    ...conversationContext(request.history),
    { role: "user", content: requestMessage(request.question, attachedPages) },
  ];

  return { context, messages, tools: toolsForMode(request.mode) };
}

async function streamOneTurn(
  request: LoopRequest,
  conversation: Conversation,
  progress: LoopProgress,
  finalTurn: boolean,
) {
  const { web, task } = request;

  web.streaming.current = web.enabled.current && !finalTurn;
  conversation.messages[0].content = systemPrompt({
    ...conversation.context,
    web: web.streaming.current,
  });
  const turn = await streamTurn(
    request.active.current,
    conversation.messages,
    conversation.tools,
    (content) => request.show(progress.answer + content),
    () => task.stopped,
    web.streaming.current,
  );

  web.streaming.current = false;

  return turn;
}

function recordTurn(task: AgentRun, turn: Turn, progress: LoopProgress) {
  progress.cost += turn.cost;
  if (turn.searches || turn.sources.length) task.trace.push("web_search");
  for (const source of turn.sources)
    if (progress.sources.size < WEB_SOURCES)
      progress.sources.set(source.url, source);
  progress.answer += turn.content;
}

function nudgedToAnswer(
  turn: Turn,
  finalTurn: boolean,
  messages: Message[],
  progress: LoopProgress,
) {
  const empty = !turn.content.trim();
  const truncated = turn.finishReason === "length";

  if (!(empty || truncated) || progress.nudged || finalTurn) return false;
  progress.nudged = true;
  if (!empty) messages.push({ role: "assistant", content: turn.content });
  messages.push({
    role: "user",
    content: empty ? EMPTY_ANSWER : CONTINUE_ANSWER,
  });

  return true;
}

async function runToolCalls(
  request: LoopRequest,
  messages: Message[],
  turn: Turn,
  progress: LoopProgress,
) {
  if (turn.content) progress.answer += "\n\n";
  compactToolResults(messages);
  messages.push({
    role: "assistant",
    content: turn.content || null,
    tool_calls: turn.calls,
    ...(turn.reasoningDetails.length
      ? { reasoning_details: turn.reasoningDetails }
      : {}),
  });

  for (const call of turn.calls) {
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: toolContent(await runTool(request.task, call)),
    });
    request.show(progress.answer);
  }
}

function isFinalTurn(step: number, task: AgentRun, policy: Policy) {
  return step > 0 && (step === policy.steps - 1 || task.calls >= policy.steps);
}

async function takeTurns(
  request: LoopRequest,
  conversation: Conversation,
  progress: LoopProgress,
) {
  const { task, policy } = request;
  const { messages } = conversation;

  for (let step = 0; step < policy.steps && !task.stopped; step++) {
    const finalTurn = isFinalTurn(step, task, policy);

    if (finalTurn) messages.push({ role: "user", content: FINAL_TURN });
    const turn = await streamOneTurn(
      request,
      conversation,
      progress,
      finalTurn,
    );

    recordTurn(task, turn, progress);
    if (task.stopped) break;

    if (!turn.calls.length || finalTurn) {
      if (nudgedToAnswer(turn, finalTurn, messages, progress)) continue;
      progress.complete =
        !!progress.answer.trim() && turn.finishReason !== "length";
      break;
    }

    await runToolCalls(request, messages, turn, progress);
    if (progress.cost >= policy.budget) break;
  }
}

export async function runAgentLoop(request: LoopRequest): Promise<LoopOutcome> {
  const { web, active } = request;
  const progress: LoopProgress = {
    answer: "",
    cost: 0,
    failure: "",
    complete: false,
    nudged: false,
    sources: new Map(),
  };

  try {
    const conversation = await openConversation(request);

    active.current = await startRun(request.bookId);
    await takeTurns(request, conversation, progress);
  } catch (error) {
    progress.failure = String(error);
  } finally {
    web.streaming.current = false;
    await stopRun(active.current);
    active.current = "";
  }

  return { ...progress, sources: [...progress.sources.values()] };
}
