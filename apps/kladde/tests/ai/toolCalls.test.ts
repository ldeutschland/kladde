import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_CALLS,
  ReasoningCollector,
  ToolCallCollector,
  parseArguments,
} from "../../src/ai/toolCalls";

const known = new Set(["search", "read_page", "archive_page"]);

function collector() {
  return new ToolCallCollector(known);
}

describe("Streamed tool call fragments", () => {
  it("builds a name streamed in pieces", () => {
    const calls = collector();

    calls.add({ index: 0, id: "a", function: { name: "read_" } });
    calls.add({ index: 0, function: { name: "page", arguments: '{"id":' } });
    calls.add({ index: 0, function: { arguments: '"p"}' } });
    expect(calls.finish()).toEqual([
      {
        id: "a",
        type: "function",
        function: { name: "read_page", arguments: '{"id":"p"}' },
      },
    ]);
  });

  it("does not let a later fragment rename a complete call", () => {
    const calls = collector();

    calls.add({ index: 0, id: "a", function: { name: "search" } });
    calls.add({ index: 0, function: { name: "archive_page" } });
    expect(calls.finish()[0].function.name).toBe("search");
  });

  it("drops fragments that never got a name", () => {
    const calls = collector();

    calls.add({ index: 0, id: "a", function: { arguments: '{"id":"x"}' } });
    calls.add({ index: 1, id: "b", function: { name: "search" } });
    expect(calls.finish().map((call) => call.id)).toEqual(["b"]);
  });

  it("replaces an id that is not text with a generated one", () => {
    const calls = collector();

    calls.add({ index: 0, id: 42, function: { name: "search" } });
    const [call] = calls.finish();

    expect(call.id).toMatch(/^call_0_[0-9a-f]{8}$/);
  });

  it("turns a name sent as object into text that matches no tool", () => {
    const calls = collector();

    calls.add({ index: 0, id: "a", function: { name: { name: "search" } } });
    const name = calls.finish()[0].function.name;

    expect(known.has(name)).toBe(false);
  });

  it("treats an out-of-range index like a missing one", () => {
    const calls = collector();

    calls.add({ index: 5000, id: "a", function: { name: "search" } });
    calls.add({ index: -1, function: { arguments: '{"query":"x"}' } });
    calls.add({ index: 1.5, id: "b", function: { name: "read_page" } });
    expect(
      calls.finish().map((call) => [call.id, call.function.arguments]),
    ).toEqual([
      ["a", '{"query":"x"}'],
      ["b", ""],
    ]);
  });

  it("stops after the maximum number of calls", () => {
    const calls = collector();

    for (let index = 0; index < MAX_TOOL_CALLS; index++)
      calls.add({ index, id: "c" + index, function: { name: "search" } });
    expect(() =>
      calls.add({ id: "extra", function: { name: "archive_page" } }),
    ).toThrow("Too many tool calls");
    expect(calls.finish()).toHaveLength(MAX_TOOL_CALLS);
  });

  it("limits arguments summed over all fragments", () => {
    const calls = collector();

    calls.add({ index: 0, function: { arguments: "x".repeat(40000) } });
    expect(() =>
      calls.add({ index: 0, function: { arguments: "y".repeat(24001) } }),
    ).toThrow("Tool arguments too long");
  });

  it("appends a repeated fragment that is not yet complete JSON", () => {
    const calls = collector();

    calls.add({ index: 0, id: "a", function: { name: "search" } });
    calls.add({ index: 0, function: { arguments: "{" } });
    calls.add({ index: 0, function: { arguments: "{" } });
    expect(calls.finish()[0].function.arguments).toBe("{{");
  });
});

describe("Argument parsing", () => {
  it("finds the first object even with braces and quotes inside strings", () => {
    expect(
      parseArguments('Sure: {"query":"a}b \\"{c\\""} and {"query":"other"}'),
    ).toEqual({ query: 'a}b "{c"' });
  });

  it("fails on unfinished or missing objects", () => {
    expect(() => parseArguments('{"query":')).toThrow(
      "Arguments are not a JSON object",
    );
    expect(() => parseArguments('"just text"')).toThrow();
    expect(() => parseArguments("{broken: json}")).toThrow();
  });

  it("returns non-object JSON unchanged for the validator to reject", () => {
    expect(parseArguments("[1,2]")).toEqual([1, 2]);
    expect(parseArguments("null")).toBeNull();
  });

  it("keeps __proto__ as plain data instead of a prototype", () => {
    const parsed = parseArguments('{"__proto__":{"id":"x"}}') as {
      id?: string;
    };

    expect(parsed.id).toBeUndefined();
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});

describe("Reasoning details", () => {
  it("drops everything once the total size is too large", () => {
    const reasoning = new ReasoningCollector();

    reasoning.add([{ type: "reasoning.text", index: 0, text: "a" }]);
    reasoning.add([
      { type: "reasoning.text", index: 1, text: "x".repeat(150001) },
    ]);
    reasoning.add([{ type: "reasoning.text", index: 2, text: "b" }]);
    expect(reasoning.result()).toEqual([]);
  });

  it("keeps at most 64 separate details", () => {
    const reasoning = new ReasoningCollector();

    reasoning.add(
      Array.from({ length: 80 }, (_, index) => ({
        type: "reasoning.text",
        index,
        text: "t",
      })),
    );
    expect(reasoning.result()).toHaveLength(64);
  });

  it("merges only details with the same index and type", () => {
    const reasoning = new ReasoningCollector();

    reasoning.add([
      { type: "reasoning.summary", index: 0, summary: "a" },
      { type: "reasoning.text", index: 0, text: "b" },
      { type: "reasoning.summary", index: 0, summary: "c", signature: null },
      ["array"],
      null,
    ]);
    expect(reasoning.result()).toEqual([
      { type: "reasoning.summary", index: 0, summary: "ac" },
      { type: "reasoning.text", index: 0, text: "b" },
    ]);
  });
});
