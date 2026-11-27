import { useEffect, useState } from "react";
import { Channel, isTauri } from "@tauri-apps/api/core";
import { command } from "../platform/native";
import type { T, Word } from "../locale/locale";
import { stopRun, type Message } from "./assistant";

export interface LocalStatus {
  available: boolean;
  reason: string;
  context: number;
}

export interface LocalParameter {
  name: string;
  description: string;
  type: "string" | "integer";
  optional: boolean;
}

export interface LocalTool {
  name: string;
  description: string;
  parameters: LocalParameter[];
}

export interface LocalRequest {
  instructions: string;
  prompt: string;
  tools: LocalTool[];
  temperature: number;
  max_tool_calls: number;
  tool_output_tokens: number;
  answer_tokens: number;
}

export interface LocalCall {
  name: string;
  arguments: string;
}

export interface Generation {
  show: (text: string) => void;
  tool: (call: LocalCall) => Promise<string>;
}

interface LocalEvent {
  kind?: unknown;
  text?: unknown;
  replace?: unknown;
  call?: unknown;
  name?: unknown;
  arguments?: unknown;
}

const UNREACHABLE_REASON = "unavailable";
const OTHER_PLATFORM = "platform";
const TEXT_TEMPERATURE = 0.3;
const TEXT_ANSWER_SHARE = 0.45;
const NO_TOOL_OUTPUT = 1;
const PAGE_CHARACTERS_PER_CONTEXT_TOKEN = 1.5;
const FAILURE_WORDS: Record<string, Word> = {
  device: "localDevice",
  unavailable: "localUnavailable",
  platform: "localUnavailable",
  missing: "localMissing",
  context: "localContext",
  busy: "localBusy",
  failed: "localFailed",
  network: "localNetwork",
  storage: "localStorage",
  checksum: "localChecksum",
  cancelled: "runStopped",
};

export async function localStatus(): Promise<LocalStatus> {
  try {
    return await command<LocalStatus>("local_ai_status");
  } catch {
    const reason = isTauri() ? UNREACHABLE_REASON : OTHER_PLATFORM;

    return { available: false, reason, context: 0 };
  }
}

export function localOffered(status: LocalStatus | null) {
  return !!status?.available;
}

export function useLocalStatus() {
  const [status, setStatus] = useState<LocalStatus | null>(null);

  useEffect(() => {
    let alive = true;

    void localStatus().then((next) => {
      if (alive) setStatus(next);
    });

    return () => {
      alive = false;
    };
  }, []);

  return status;
}

export function localFailure(problem: unknown, t: T) {
  const code = String(problem).replace(/^Error: /, "");
  const word = FAILURE_WORDS[code];

  return word ? t(word) : code;
}

export function startLocal(space: string) {
  return command<string>("local_ai_start", { space });
}

export async function stopLocal(run: string) {
  if (!run) return;
  await command("local_ai_stop", { run }).catch(() => {});
}

export function stopAnyRun(run: string) {
  void stopRun(run);
  void stopLocal(run);
}

async function answerTool(
  run: string,
  call: string,
  request: LocalCall,
  generation: Generation,
) {
  let output: string;

  try {
    output = await generation.tool(request);
  } catch (error) {
    output = "Error: " + String(error);
  }

  await command("local_ai_tool_result", { run, call, output }).catch(() => {});
}

function eventCall(event: LocalEvent) {
  const { call, name, arguments: args } = event;

  if (typeof call !== "string" || typeof name !== "string") return null;
  if (typeof args !== "string") return null;

  return { call, request: { name, arguments: args } };
}

export async function generateLocal(
  run: string,
  request: LocalRequest,
  generation: Generation,
) {
  if (!isTauri()) throw Error("unavailable");
  let text = "";
  let tools = Promise.resolve();
  const channel = new Channel<LocalEvent>();

  channel.onmessage = (event) => {
    if (event.kind === "text" && typeof event.text === "string") {
      text = event.replace === true ? event.text : text + event.text;
      generation.show(text);
    }

    const tool = event.kind === "tool" ? eventCall(event) : null;

    if (tool)
      tools = tools.then(() =>
        answerTool(run, tool.call, tool.request, generation),
      );
  };

  await command("local_ai_run", { run, request, channel });

  return text;
}

function conversation(turns: Message[]) {
  if (turns.length === 1) return String(turns[0].content ?? "");

  return turns
    .map((turn) => {
      const speaker = turn.role === "assistant" ? "Your answer" : "Request";

      return speaker + ":\n" + String(turn.content ?? "");
    })
    .join("\n\n");
}

function textRequest(messages: Message[], status: LocalStatus): LocalRequest {
  const system = messages.filter((message) => message.role === "system");
  const turns = messages.filter((message) => message.role !== "system");

  return {
    instructions: system.map((m) => String(m.content ?? "")).join("\n\n"),
    prompt: conversation(turns),
    tools: [],
    temperature: TEXT_TEMPERATURE,
    max_tool_calls: 0,
    tool_output_tokens: NO_TOOL_OUTPUT,
    answer_tokens: Math.floor(status.context * TEXT_ANSWER_SHARE),
  };
}

export async function completeLocally(
  space: string,
  messages: Message[],
  show: (text: string) => void,
  active?: { current: string },
) {
  const status = await localStatus();

  if (!status.available) throw Error(status.reason);
  const run = await startLocal(space);

  if (active) active.current = run;

  try {
    return await generateLocal(run, textRequest(messages, status), {
      show,
      tool: () => Promise.reject(Error("No tools")),
    });
  } finally {
    await stopLocal(run);
    if (active) active.current = "";
  }
}

export function localTextLimit(status: LocalStatus | null, fallback: number) {
  if (!status?.available) return fallback;

  return Math.min(
    fallback,
    Math.floor(status.context * PAGE_CHARACTERS_PER_CONTEXT_TOKEN),
  );
}
