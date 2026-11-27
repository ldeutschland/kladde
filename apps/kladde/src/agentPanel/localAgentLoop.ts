import { aiLanguage, type T } from "../locale/locale";
import type { AgentRun } from "../ai/AgentRun";
import { LocalHandles } from "../ai/localHandles";
import {
  generateLocal,
  localFailure,
  localStatus,
  startLocal,
  stopLocal,
  type LocalRequest,
} from "../ai/localModel";
import {
  answerOnlyInstructions,
  answerOnlyPrompt,
  localBudget,
  localInstructions,
  localPrompt,
  replyLanguage,
  type LocalBudget,
} from "../ai/localPrompts";
import { callLocalTool, localToolPlans } from "../ai/localTools";
import type { PromptContext } from "../ai/prompts";
import type { LoopOutcome, LoopRequest } from "./agentLoop";

const AGENT_TEMPERATURE = 0.2;
const MAX_TOOL_CALLS = 6;
const CONTEXT_FULL = "context";
const PAGE_LINKS = /\[([^\]\n]{1,300})\]\(kladde:([^)\s]{1,80})\)/g;

export interface LocalLoopRequest extends LoopRequest {
  t: T;
  lang: string;
}

interface LocalRun {
  request: LocalLoopRequest;
  context: PromptContext;
  language: string;
  handles: LocalHandles;
  budget: LocalBudget;
  notes: string[];
  text: string;
}

function openPage(task: AgentRun) {
  const page = task.current ? task.page(task.current.id) : undefined;

  if (!page || page.archived || page.kind === "chat") return null;
  task.shared.add(page.id);

  return { id: page.id, title: page.title };
}

function checkedLinks(answer: string, run: LocalRun) {
  const { task } = run.request;

  return answer.replace(PAGE_LINKS, (_, label: string, target: string) => {
    const id = run.handles.pageId(target);
    const page = id ? task.book.pages.get(id) : undefined;
    const usable = !!id && !!page && !page.archived && !task.excluded(id);

    return usable ? "[" + label + "](kladde:" + id + ")" : label;
  });
}

async function agentRequest(run: LocalRun): Promise<LocalRequest> {
  const { request, handles, budget, context } = run;
  const attached = await request.task.attach(request.pages);
  const parts = {
    question: request.question,
    history: request.history,
    open: openPage(request.task),
    attached,
  };

  return {
    instructions: localInstructions(context, budget, run.language),
    prompt: localPrompt(parts, handles, budget),
    tools: localToolPlans(context.mode),
    temperature: AGENT_TEMPERATURE,
    max_tool_calls: Math.min(MAX_TOOL_CALLS, request.policy.steps),
    tool_output_tokens: budget.toolTokens,
    answer_tokens: budget.answerTokens,
  };
}

function notesRequest(run: LocalRun): LocalRequest {
  return {
    instructions: answerOnlyInstructions(run.context, run.language),
    prompt: answerOnlyPrompt(
      run.request.question,
      run.notes,
      run.budget.attached,
    ),
    tools: [],
    temperature: AGENT_TEMPERATURE,
    max_tool_calls: 0,
    tool_output_tokens: 1,
    answer_tokens: run.budget.answerTokens,
  };
}

function show(run: LocalRun, text: string) {
  run.text = text;
  run.request.show(checkedLinks(text, run));
}

function generate(run: LocalRun, prepared: LocalRequest) {
  const { request, handles, budget } = run;

  return generateLocal(request.active.current, prepared, {
    show: (text) => show(run, text),
    tool: async (call) => {
      const output = await callLocalTool(
        request.task,
        handles,
        call,
        budget.toolCharacters,
      );

      run.notes.push(output);
      show(run, run.text);

      return output;
    },
  });
}

async function answered(run: LocalRun, prepared: LocalRequest) {
  try {
    return await generate(run, prepared);
  } catch (error) {
    const recoverable = String(error) === CONTEXT_FULL && run.notes.length > 0;

    if (!recoverable || run.request.task.stopped) throw error;

    return generate(run, notesRequest(run));
  }
}

async function preparedRun(request: LocalLoopRequest, context: number) {
  const prompt = await request.context();

  return {
    request,
    context: { ...prompt, mode: request.task.mode },
    language: replyLanguage(aiLanguage(request.task.book) || request.lang),
    handles: new LocalHandles(),
    budget: localBudget(context),
    notes: [],
    text: "",
  };
}

export async function runLocalAgentLoop(
  request: LocalLoopRequest,
): Promise<LoopOutcome> {
  const outcome = {
    answer: "",
    cost: 0,
    failure: "",
    complete: false,
    sources: [],
  };
  const status = await localStatus();

  if (!status.available)
    return { ...outcome, failure: localFailure(status.reason, request.t) };

  try {
    const run = await preparedRun(request, status.context);
    const prepared = await agentRequest(run);

    request.active.current = await startLocal(request.bookId);
    outcome.answer = checkedLinks(await answered(run, prepared), run);
    outcome.complete = !!outcome.answer.trim();
  } catch (error) {
    outcome.failure = localFailure(error, request.t);
  } finally {
    await stopLocal(request.active.current);
    request.active.current = "";
  }

  return outcome;
}
