export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDelta {
  index?: unknown;
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

export type ReasoningDetail = Record<string, unknown>;

export const MAX_TOOL_CALLS = 32;
const MAX_ARGUMENT_LENGTH = 64000;
const MAX_REASONING_DETAILS = 64;
const MAX_REASONING_LENGTH = 150000;

function text(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);

  return "";
}

function isJson(raw: string) {
  try {
    JSON.parse(raw);

    return true;
  } catch {
    return false;
  }
}

function repeatsComplete(current: string, next: string) {
  return current === next && isJson(current);
}

function freshCall(): ToolCall {
  return { id: "", type: "function", function: { name: "", arguments: "" } };
}

export class ToolCallCollector {
  calls: ToolCall[] = [];
  private slots = new Map<number, number>();

  constructor(private known: Set<string>) {}

  add(delta: ToolDelta) {
    const position = this.position(delta);

    if (position >= MAX_TOOL_CALLS) throw Error("Too many tool calls");
    const call = (this.calls[position] ??= freshCall());
    const id = text(delta.id);

    if (id && !call.id) call.id = id;
    this.addName(call, text(delta.function?.name));
    const args = text(delta.function?.arguments);

    if (call.function.arguments.length + args.length > MAX_ARGUMENT_LENGTH)
      throw Error("Tool arguments too long");
    if (args && !repeatsComplete(call.function.arguments, args))
      call.function.arguments += args;
  }

  finish() {
    return this.calls
      .filter((call) => call?.function.name)
      .map((call, i) => ({
        ...call,
        id: call.id || "call_" + i + "_" + crypto.randomUUID().slice(0, 8),
      }));
  }

  private position(delta: ToolDelta) {
    const id = text(delta.id);
    const index = Number.isInteger(delta.index) ? Number(delta.index) : -1;

    if (index < 0 || index >= MAX_TOOL_CALLS) {
      if (!id && this.calls.length) return this.calls.length - 1;

      return this.calls.length;
    }

    const known = this.slots.get(index);

    if (known === undefined) {
      this.slots.set(index, this.calls.length);

      return this.calls.length;
    }

    const current = this.calls[known];
    const replaced = !!id && !!current.id && current.id !== id;

    if (!replaced) return known;
    this.slots.set(index, this.calls.length);

    return this.calls.length;
  }

  private addName(call: ToolCall, name: string) {
    if (!name || call.function.name === name) return;
    if (!call.function.name || !this.known.has(call.function.name))
      call.function.name += name;
  }
}

function firstObject(raw: string) {
  const start = raw.indexOf("{");

  if (start < 0) return null;
  let depth = 0,
    quoted = false,
    escaped = false;

  for (let i = start; i < raw.length; i++) {
    const c = raw[i];

    if (escaped) escaped = false;
    else if (c === "\\") escaped = quoted;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && c === "{") depth++;
    else if (!quoted && c === "}" && --depth === 0)
      return raw.slice(start, i + 1);
  }

  return null;
}

export function parseArguments(raw: string): unknown {
  const trimmed = raw.trim();

  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed);

    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    const object = firstObject(trimmed);

    if (!object) throw Error("Arguments are not a JSON object");

    return JSON.parse(object);
  }
}

export class ReasoningCollector {
  private details: ReasoningDetail[] = [];
  private size = 0;
  private overflow = false;

  add(parts: unknown) {
    if (!Array.isArray(parts) || this.overflow) return;

    for (const part of parts) {
      if (!part || typeof part !== "object" || Array.isArray(part)) continue;
      this.size += JSON.stringify(part).length;

      if (this.size > MAX_REASONING_LENGTH) {
        this.overflow = true;
        this.details = [];

        return;
      }

      this.merge(part as ReasoningDetail);
    }
  }

  result() {
    return this.details;
  }

  private merge(part: ReasoningDetail) {
    const index = Number.isInteger(part.index) ? part.index : undefined;
    const current =
      index === undefined
        ? undefined
        : this.details.find((d) => d.index === index && d.type === part.type);

    if (!current) {
      if (this.details.length < MAX_REASONING_DETAILS)
        this.details.push({ ...part });

      return;
    }

    for (const [key, value] of Object.entries(part)) {
      const before = current[key];

      if (
        ["text", "summary", "data"].includes(key) &&
        typeof before === "string" &&
        typeof value === "string"
      )
        current[key] = before + value;
      else if (value !== null && value !== undefined) current[key] = value;
    }
  }
}
