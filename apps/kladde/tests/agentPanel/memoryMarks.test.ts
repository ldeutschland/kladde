import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Item } from "../../src/agentPanel/types";
import type { Notebook } from "../../src/notebook/notebook";
import type { T } from "../../src/locale/locale";

const memory = vi.hoisted(() => ({
  result: null as unknown,
  failure: null as Error | null,
}));

vi.mock("../../src/ai/memory", () => ({
  rememberExchange: vi.fn(async () => {
    if (memory.failure) throw memory.failure;

    return memory.result;
  }),
}));

const { rememberReply, savingMark, withMemory } =
  await import("../../src/agentPanel/memoryMarks");

const book = {} as Notebook;
const t = ((word: string) => word) as unknown as T;

describe("Memory marks on replies", () => {
  beforeEach(() => {
    memory.result = null;
    memory.failure = null;
  });

  it("marks only a trailing assistant reply", () => {
    const mark = savingMark();
    const question: Item = { role: "user", text: "q" };
    const answer: Item = { role: "assistant", text: "a" };

    expect(withMemory([question], mark)).toEqual([question]);
    expect(withMemory([], mark)).toEqual([]);
    const marked = withMemory([question, answer], mark);

    expect(marked[1]).toEqual({ ...answer, memory: mark });
    expect(answer.memory).toBeUndefined();
  });

  it("reports saved changes and nothing when the memory stayed the same", async () => {
    memory.result = {
      page: "mem",
      changed: true,
      cost: 0.01,
      added: ["mag Tee"],
      removed: [],
    };
    expect(await rememberReply(book, t, "q", "a")).toEqual({
      state: "saved",
      page: "mem",
      added: ["mag Tee"],
      removed: [],
      cost: 0.01,
      error: "",
    });
    memory.result = {
      page: "mem",
      changed: false,
      cost: 0,
      added: [],
      removed: [],
    };
    expect(await rememberReply(book, t, "q", "a")).toBeUndefined();
  });

  it("turns errors into a failed mark instead of throwing", async () => {
    memory.failure = Error("Run already active");
    expect(await rememberReply(book, t, "q", "a")).toMatchObject({
      state: "failed",
      error: "Error: Run already active",
    });
  });
});
