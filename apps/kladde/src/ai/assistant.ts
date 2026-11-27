import { Channel, isTauri } from "@tauri-apps/api/core";
import { command } from "../platform/native";
import {
  ReasoningCollector,
  ToolCallCollector,
  type ReasoningDetail,
  type ToolCall,
  type ToolDelta,
} from "./toolCalls";

export type Provider = "openrouter" | "local";
export interface Policy {
  enabled: boolean;
  zdr: boolean;
  web_search: boolean;
  provider?: Provider;
  model: string;
  budget: number;
  steps: number;
}
export const defaultPolicy: Policy = {
  enabled: false,
  zdr: true,
  web_search: false,
  provider: "openrouter",
  model: "",
  budget: 0.5,
  steps: 25,
};

export function providerOf(policy: Policy): Provider {
  return policy.provider ?? "openrouter";
}

export function onDevice(policy: Policy) {
  return providerOf(policy) === "local";
}

export function aiReady(policy: Policy) {
  return policy.enabled && !!policy.model;
}
export type Message = Record<string, unknown>;
export interface WebSource {
  url: string;
  title: string;
}
export function webSource(value: unknown): WebSource | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    value.url.length > 2048
  )
    return null;

  try {
    const url = new URL(value.url);

    if (
      !["https:", "http:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
    const title =
      "title" in value && typeof value.title === "string"
        ? value.title.trim().slice(0, 240)
        : "";

    return { url: url.href, title: title || url.hostname };
  } catch {
    return null;
  }
}

interface Chunk {
  choices?: {
    message?: { annotations?: unknown[] };
    finish_reason?: string;
    delta?: {
      content?: unknown;
      annotations?: unknown[];
      tool_calls?: unknown;
      reasoning_details?: unknown;
    };
  }[];
  usage?: {
    total_tokens: number;
    server_tool_use_details?: { web_search_requests?: number };
    server_tool_use?: { web_search_requests?: number };
  };
}
interface Listener {
  onmessage: (part: Chunk) => void;
}

export async function loadPolicy(space: string) {
  try {
    return {
      ...defaultPolicy,
      ...(await command<Policy>("ai_policy", { space })),
    };
  } catch {
    return defaultPolicy;
  }
}

export function savePolicy(space: string, settings: Policy) {
  return command("ai_settings", { space, settings });
}

let modelsLoaded = false;

export async function loadModels(space: string) {
  const list = await command<{ id: unknown }[]>("ai_models", { space });

  modelsLoaded = true;

  return list
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string")
    .slice(0, 1000);
}

export async function startRun(space: string) {
  if (!modelsLoaded) await loadModels(space);

  return command<string>("ai_start", { space });
}

export async function stopRun(run: string) {
  if (!run) return;
  await command("ai_stop", { run }).catch(() => {});
}

export async function streamTurn(
  run: string,
  messages: Message[],
  toolList: unknown[],
  show: (text: string) => void,
  stopped: () => boolean,
  useWeb = false,
) {
  const known = new Set(
    toolList.map((tool) =>
      String((tool as { function?: { name?: unknown } }).function?.name ?? ""),
    ),
  );
  const collector = new ToolCallCollector(known);
  const reasoning = new ReasoningCollector();
  const sources = new Map<string, WebSource>();
  let searches = 0;
  let finishReason = "";
  let content = "";
  let tokens = 0;
  let invalid = "";
  const channel: Listener = isTauri()
    ? new Channel<Chunk>()
    : { onmessage: () => {} };

  channel.onmessage = (part) => {
    if (stopped() || invalid) return;
    const choice = part.choices?.[0];
    const delta = choice?.delta;

    if (choice?.finish_reason) finishReason = choice.finish_reason;

    if (useWeb) {
      searches = Math.max(
        searches,
        part.usage?.server_tool_use_details?.web_search_requests ??
          part.usage?.server_tool_use?.web_search_requests ??
          0,
      );

      for (const a of delta?.annotations ??
        choice?.message?.annotations ??
        []) {
        if (
          !a ||
          typeof a !== "object" ||
          !("url_citation" in a) ||
          sources.size >= 24
        )
          continue;
        const source = webSource(a.url_citation);

        if (source) sources.set(source.url, source);
      }
    }

    if (typeof delta?.content === "string" && delta.content) {
      content += delta.content;
      show(content);
    }

    if (part.usage) tokens = part.usage.total_tokens;
    reasoning.add(delta?.reasoning_details);
    const deltas = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];

    try {
      for (const c of deltas)
        if (c && typeof c === "object") collector.add(c as ToolDelta);
    } catch (error) {
      invalid = String(error);
    }
  };

  const cost = await command<number>("ai_turn", {
    run,
    turn: { messages, tools: toolList, web_search: useWeb },
    channel,
  });

  if (invalid) throw Error(invalid);
  const calls: ToolCall[] = collector.finish();
  const reasoningDetails: ReasoningDetail[] = reasoning.result();

  return {
    content,
    calls,
    reasoningDetails,
    cost,
    tokens,
    searches,
    sources: [...sources.values()],
    finishReason,
  };
}
