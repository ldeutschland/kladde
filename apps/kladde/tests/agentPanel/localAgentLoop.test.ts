import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { AgentRun } from "../../src/ai/AgentRun";
import type { Policy } from "../../src/ai/assistant";
import type { LocalRequest } from "../../src/ai/localModel";
import type { T } from "../../src/locale/locale";
import type { Notebook } from "../../src/notebook/notebook";

const local = vi.hoisted(() => ({ requests: [] as LocalRequest[] }));

vi.mock("../../src/ai/localModel", () => ({
  localStatus: vi.fn(async () => ({
    available: true,
    reason: "",
    context: 8192,
  })),
  localFailure: vi.fn((problem: unknown) => String(problem)),
  startLocal: vi.fn(async () => "run-1"),
  stopLocal: vi.fn(async () => {}),
  generateLocal: vi.fn(async (_run: string, request: LocalRequest) => {
    local.requests.push(request);

    return "Antwort";
  }),
}));

const { runLocalAgentLoop } =
  await import("../../src/agentPanel/localAgentLoop");
const { setAiLanguage } = await import("../../src/locale/locale");

const GERMAN_RULE = "- Always reply in German, also after tool calls.";
const ENGLISH_RULE = "- Always reply in English, also after tool calls.";
const policy: Policy = {
  enabled: true,
  zdr: true,
  web_search: false,
  model: "gemma-4-e2b",
  budget: 0,
  steps: 6,
};
const t = ((key: string) => key) as T;

function fakeTask() {
  return {
    book: {
      pages: new Map(),
      settings: new Y.Doc().getMap<unknown>("settings"),
    },
    mode: "auto",
    current: null,
    stopped: false,
    shared: new Set<string>(),
    attach: async () => [],
    page: () => undefined,
    excluded: () => false,
  };
}

function loop(task: ReturnType<typeof fakeTask>, lang: string) {
  return runLocalAgentLoop({
    bookId: "space",
    task: task as unknown as AgentRun,
    mode: "auto",
    policy,
    question: "Frage",
    history: [],
    pages: [],
    context: async () => ({
      mode: "auto",
      web: false,
      instructions: [],
      template: null,
      memories: [],
      memoryAuto: false,
      today: "2026-11-28",
    }),
    web: { enabled: { current: false }, streaming: { current: false } },
    active: { current: "" },
    show: () => {},
    t,
    lang,
  });
}

function instructionLines() {
  return local.requests.at(-1)?.instructions.split("\n") ?? [];
}

describe("Local agent loop language", () => {
  beforeEach(() => {
    local.requests = [];
  });

  it("answers in the display language by default", async () => {
    const outcome = await loop(fakeTask(), "en");

    expect(outcome).toMatchObject({ answer: "Antwort", complete: true });
    expect(instructionLines()).toContain(ENGLISH_RULE);
    await loop(fakeTask(), "de");
    expect(instructionLines()).toContain(GERMAN_RULE);
  });

  it("prefers the language chosen for the notebook", async () => {
    const task = fakeTask();

    setAiLanguage(task.book as unknown as Notebook, "en");
    await loop(task, "de");
    expect(instructionLines()).toContain(ENGLISH_RULE);
    expect(instructionLines()).not.toContain(GERMAN_RULE);
  });

  it("ignores a stored language it does not know", async () => {
    const task = fakeTask();

    task.book.settings.set("aiLanguage", "fr");
    await loop(task, "de");
    expect(instructionLines()).toContain(GERMAN_RULE);
  });
});
