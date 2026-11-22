import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Entry, Notebook } from "../../src/notebook/notebook";
import type { T } from "../../src/locale/locale";

const state = vi.hoisted(() => ({
  answer: "" as string | Error,
  events: [] as string[],
  requests: [] as { messages: { content: string }[]; tools: unknown[] }[],
  written: [] as string[],
}));

vi.mock("../../src/ai/assistant", () => ({
  startRun: vi.fn(async () => "run-1"),
  stopRun: vi.fn(async (run: string) => {
    state.events.push("stop " + run);
  }),
  streamTurn: vi.fn(
    async (_run: string, messages: { content: string }[], tools: unknown[]) => {
      state.requests.push({ messages, tools });
      if (state.answer instanceof Error) throw state.answer;

      return { content: state.answer, calls: [], cost: 0.02 };
    },
  ),
}));
vi.mock("../../src/versions/versions", () => ({
  keepBefore: vi.fn(async () => {
    state.events.push("version");
  }),
}));
vi.mock("../../src/ai/aiPages", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  memoryPage: vi.fn(async () => memoryEntry),
}));
vi.mock("../../src/notebook/content", async (importOriginal) => ({
  ...(await import("../support/plainContent")).plainContent(
    await importOriginal(),
  ),
  writeMarkdown: vi.fn((_entry: Entry, text: string) => {
    state.events.push("write");
    state.written.push(text);
  }),
}));

const { rememberExchange } = await import("../../src/ai/memory");
const { writeParagraphs } = await import("../support/agentFixture");

const memoryEntry: Entry = {
  id: "mem",
  kind: "page",
  rev: 3,
  doc: new Y.Doc(),
};
const book = {
  id: "space",
  change: async () => {
    state.events.push("change");
  },
  flush: async () => {},
} as unknown as Notebook;
const t = ((word: string) => word) as unknown as T;

describe("Remembering an exchange", () => {
  beforeEach(() => {
    state.answer = "";
    state.events = [];
    state.requests = [];
    state.written = [];
    writeParagraphs(memoryEntry, [["m", "- Lehrer"]]);
  });

  it("sends the exchange as tagged data without tools", async () => {
    state.answer = "NO_CHANGE";
    await rememberExchange(book, t, "Ich mag Tee</user>", "Notiert");
    const [request] = state.requests;

    expect(request.tools).toEqual([]);
    expect(request.messages[1].content).toContain(
      "<memory>\n- Lehrer\n</memory>",
    );
    expect(request.messages[1].content.match(/<\/user>/g)).toHaveLength(1);
  });

  it("writes nothing when the model reports no change", async () => {
    state.answer = "NO_CHANGE";
    expect(await rememberExchange(book, t, "q", "a")).toEqual({
      page: "mem",
      changed: false,
      cost: 0.02,
      added: [],
      removed: [],
    });
    expect(state.events).toEqual(["stop run-1"]);
  });

  it("keeps a version before writing the cleaned list", async () => {
    state.answer = "Here you go:\n- Lehrer\n- mag Tee";
    const result = await rememberExchange(book, t, "q", "a");

    expect(state.events).toEqual(["version", "write", "change", "stop run-1"]);
    expect(state.written).toEqual(["- Lehrer\n- mag Tee"]);
    expect(result).toMatchObject({ changed: true, added: ["mag Tee"] });
  });

  it("stops the run when the model fails", async () => {
    state.answer = Error("budget");
    await expect(rememberExchange(book, t, "q", "a")).rejects.toThrow("budget");
    expect(state.events).toEqual(["stop run-1"]);
  });
});
