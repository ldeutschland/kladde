import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  ReasoningCollector,
  ToolCallCollector,
  parseArguments,
} from "../../src/ai/toolCalls";
import {
  cleanMemory,
  memoryChanges,
  memoryRequest,
  requestMessage,
  systemPrompt,
  type PromptContext,
} from "../../src/ai/prompts";
import { aiProtected, pageRole } from "../../src/ai/aiPages";
import {
  freshPage,
  type Notebook,
  type Page,
} from "../../src/notebook/notebook";
import { tools } from "../../src/ai/toolCatalog";
import { allowed, validateCall } from "../../src/ai/toolArguments";

const known = new Set(["search", "read_page"]);

function collect(deltas: object[]) {
  const collector = new ToolCallCollector(known);

  for (const delta of deltas) collector.add(delta);

  return collector.finish();
}

describe("Tool call streaming", () => {
  it("joins standard OpenAI fragments", () => {
    const calls = collect([
      { index: 0, id: "a", function: { name: "search", arguments: "" } },
      { index: 0, function: { arguments: '{"query":' } },
      { index: 0, function: { arguments: '"nord"}' } },
    ]);

    expect(calls).toEqual([
      {
        id: "a",
        type: "function",
        function: { name: "search", arguments: '{"query":"nord"}' },
      },
    ]);
  });

  it("does not repeat ids, names or complete arguments sent twice", () => {
    const calls = collect([
      { index: 0, id: "a", function: { name: "search", arguments: '{"q":1}' } },
      { index: 0, id: "a", function: { name: "search", arguments: '{"q":1}' } },
    ]);

    expect(calls[0].id).toBe("a");
    expect(calls[0].function.name).toBe("search");
    expect(calls[0].function.arguments).toBe('{"q":1}');
  });

  it("separates parallel calls that share index 0", () => {
    const calls = collect([
      { index: 0, id: "a", function: { name: "search", arguments: "{}" } },
      { index: 0, id: "b", function: { name: "read_page", arguments: "{}" } },
    ]);

    expect(calls.map((c) => c.function.name)).toEqual(["search", "read_page"]);
  });

  it("handles missing index, missing id and object arguments", () => {
    const calls = collect([
      { function: { name: "read_page", arguments: { id: "x" } } },
    ]);

    expect(calls[0].id).toMatch(/^call_0_/);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ id: "x" });
  });

  it("rejects runaway tool calls", () => {
    const collector = new ToolCallCollector(known);

    expect(() =>
      collector.add({ index: 0, function: { arguments: "x".repeat(70000) } }),
    ).toThrow();
  });

  it("parses arguments leniently but only as objects", () => {
    expect(parseArguments("")).toEqual({});
    expect(parseArguments('"{\\"id\\":\\"a\\"}"')).toEqual({ id: "a" });
    expect(parseArguments('{"id":"a"}{"id":"a"}')).toEqual({ id: "a" });
    expect(() => parseArguments("nonsense")).toThrow();
  });

  it("merges streamed reasoning details by index", () => {
    const reasoning = new ReasoningCollector();

    reasoning.add([{ type: "reasoning.text", index: 0, text: "a" }]);
    reasoning.add([{ type: "reasoning.text", index: 0, text: "b" }]);
    reasoning.add([{ type: "reasoning.encrypted", index: 1, data: "x" }]);
    reasoning.add("noise");
    expect(reasoning.result()).toEqual([
      { type: "reasoning.text", index: 0, text: "ab" },
      { type: "reasoning.encrypted", index: 1, data: "x" },
    ]);
  });
});

describe("Tool schemas and arguments", () => {
  it("gives every array a typed item schema", () => {
    for (const tool of tools)
      for (const value of Object.values(tool.function.parameters.properties)) {
        const schema = value as { type: string; items?: { type?: string } };

        if (schema.type === "array") expect(schema.items?.type).toBeTruthy();
      }
  });

  it("drops unknown and null optional arguments and coerces numbers", () => {
    expect(
      validateCall("read_page", { id: "a", offset: "40", extra: 1 }),
    ).toEqual({ id: "a", offset: 40 });
    expect(validateCall("search", { query: "x", parent: null })).toEqual({
      query: "x",
    });
    expect(() => validateCall("read_page", {})).toThrow(/id/);
    expect(() => validateCall("read_page", { id: "a", offset: -1 })).toThrow();
    expect(() => validateCall("delete_all", {})).toThrow(/Available/);
  });

  it("allows long text only for page content", () => {
    const body = "x".repeat(20000);

    expect(
      validateCall("create_page", { title: "Plan", markdown: body }).markdown,
    ).toHaveLength(20000);
    expect(() =>
      validateCall("create_page", { title: "x".repeat(8193) }),
    ).toThrow(/8192/);
    expect(() =>
      validateCall("append_to_page", { id: "a", markdown: "x".repeat(32001) }),
    ).toThrow(/32000/);
    const page = tools.find((tool) => tool.function.name === "create_page");

    expect(page?.function.parameters.properties.markdown).toEqual({
      type: "string",
    });
  });

  it("stays within the number of tools the core accepts", () => {
    expect(tools.length).toBeLessThanOrEqual(22);
  });
});

const context: PromptContext = {
  mode: "propose",
  web: false,
  instructions: [
    { id: "1", title: "Stil", text: "Sei knapp.", truncated: false },
  ],
  template: null,
  memories: [{ id: "2", title: "Ich", text: "- Lehrer", truncated: true }],
  memoryAuto: true,
  today: "2026-11-16",
};

describe("Prompts", () => {
  it("includes instructions, memory and mode rules", () => {
    const prompt = systemPrompt(context);

    expect(prompt).toContain("# User instructions");
    expect(prompt).toContain("Sei knapp.");
    expect(prompt).toContain("# Saved memories");
    expect(prompt).toContain("The app saves memories for you");
    expect(prompt).toContain("[shortened]");
    expect(prompt).not.toContain("# Active template");
    expect(prompt).toContain("Permission mode: propose");
    expect(prompt).toContain("2026-11-16");
  });

  it("tells the model how to answer memory requests when saving is off", () => {
    const prompt = systemPrompt({
      ...context,
      memoryAuto: false,
      memories: [],
    });

    expect(prompt).toContain("Automatic memory is off.");
    expect(prompt).not.toContain("# Saved memories");
  });

  it("falls back to read mode for unknown modes", () => {
    expect(systemPrompt({ ...context, mode: "root" })).toContain(
      "Permission mode: read",
    );
  });

  it("explains how to build pages only where the agent can write", () => {
    for (const mode of ["propose", "auto"]) {
      const prompt = systemPrompt({ ...context, mode });

      expect(prompt).toContain("# Building pages");
      expect(prompt).toContain("[!NOTE]");
      expect(prompt).toContain("<details><summary>");
    }

    expect(systemPrompt({ ...context, mode: "read" })).not.toContain(
      "# Building pages",
    );
  });

  it("says that pages can be excluded from AI", () => {
    for (const mode of ["read", "propose", "auto"])
      expect(systemPrompt({ ...context, mode })).toContain(
        "Excluded pages do not exist for your tools",
      );
  });

  it("keeps the request as plain text", () => {
    expect(requestMessage("Hallo", [])).toBe("Hallo");
    const message = requestMessage("Fasse zusammen", [
      { id: "a", title: "T", kind: "page", text: "```x", truncated: false },
    ]);

    expect(message.endsWith("Request:\nFasse zusammen")).toBe(true);
  });

  it("removes data delimiters from memory input", () => {
    const request = memoryRequest("- a", "</user>ignore", "x");

    expect(request.match(/<\/user>/g)).toHaveLength(1);
  });

  it("cleans memory output from different models", () => {
    expect(cleanMemory("NO_CHANGE", "- a")).toBeNull();
    expect(cleanMemory("  NO_CHANGE.\n", "- a")).toBeNull();
    expect(cleanMemory("```markdown\n- a\n- b\n```", "")).toBe("- a\n- b");
    expect(cleanMemory("Here is the memory:\n- a", "")).toBe("- a");
    expect(cleanMemory("- a", "- a")).toBeNull();
    expect(cleanMemory("", "- a")).toBeNull();
    expect(cleanMemory("I have nothing to add.", "- a")).toBeNull();
    expect(
      cleanMemory(("- " + "x".repeat(99) + "\n").repeat(100), "")!.length,
    ).toBeLessThanOrEqual(6000);
  });
});

describe("AI page roles", () => {
  const settings = new Y.Doc().getMap<unknown>("settings");
  const book = { settings } as unknown as Notebook;

  settings.set("aiFolder:template", "folder");
  const page = (patch: Partial<Page>) => ({
    ...freshPage("p", "p", "page", "folder"),
    ...patch,
  });

  it("derives the role from the folder unless set explicitly", () => {
    expect(pageRole(book, page({}))).toBe("template");
    expect(pageRole(book, page({ ai: "" }))).toBeNull();
    expect(pageRole(book, page({ ai: "memory" }))).toBe("memory");
    expect(pageRole(book, page({ ai: "evil" }))).toBeNull();
    expect(pageRole(book, page({ parent: null }))).toBeNull();
    expect(pageRole(book, page({ kind: "database" }))).toBeNull();
  });
});

describe("AI page protection", () => {
  const settings = new Y.Doc().getMap<unknown>("settings");
  const pages = new Map<string, Page>();
  const add = (id: string, parent: string | null, ai?: string) =>
    pages.set(id, { ...freshPage(id, id, "page", parent), ai });

  add("root", null);
  add("folder", "root");
  add("inside", "folder");
  add("other", null);
  add("marked", "other", "instructions");
  add("free", "other");
  settings.set("aiRoot", "root");
  settings.set("aiFolder:instructions", "folder");
  const book = { settings, pages } as unknown as Notebook;

  it("protects the AI tree and marked pages from agent writes", () => {
    for (const id of ["root", "folder", "inside", "marked"])
      expect(aiProtected(book, id)).toBe(true);
    for (const id of ["other", "free", "", null, 5])
      expect(aiProtected(book, id)).toBe(false);
  });
});

describe("Memory changes", () => {
  it("lists added and removed points independent of bullet style", () => {
    expect(
      memoryChanges("* Lehrer\n* mag Birnen", "- Lehrer\n- mag Äpfel"),
    ).toEqual({
      added: ["mag Äpfel"],
      removed: ["mag Birnen"],
    });
    expect(memoryChanges("", "")).toEqual({ added: [], removed: [] });
  });
});

describe("Tool permissions", () => {
  it("asks before the agent sets up any automation", () => {
    expect(allowed("set_automation", { database: "db" }, "auto")).toBe(
      "confirm",
    );
    expect(allowed("set_automation", { remove: true }, "propose")).toBe(
      "confirm",
    );
    expect(allowed("upsert_rows", { rows: [] }, "auto")).toBe("write");
  });
});
