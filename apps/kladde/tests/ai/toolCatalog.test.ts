import { describe, expect, it } from "vitest";
import {
  READ_TOOLS,
  definitions,
  tools,
  toolsForMode,
} from "../../src/ai/toolCatalog";
import { allowed, validateCall } from "../../src/ai/toolArguments";

const names = (list: typeof tools) => list.map((tool) => tool.function.name);

describe("Tool catalog", () => {
  it("offers only read tools in read mode", () => {
    const offered = names(toolsForMode("read"));

    expect(new Set(offered)).toEqual(READ_TOOLS);
    for (const name of offered)
      expect(allowed(name, {}, "read"), name).toBe("read");
  });

  it("lists every read tool in the schema definitions", () => {
    for (const name of READ_TOOLS)
      expect(Object.hasOwn(definitions, name), name).toBe(true);
  });

  it("marks exactly the non-optional arguments as required", () => {
    for (const tool of tools) {
      const schema = definitions[tool.function.name];
      const required = Object.keys(schema).filter(
        (key) => !schema[key].endsWith("?"),
      );

      expect(tool.function.parameters.required, tool.function.name).toEqual(
        required,
      );
      expect(Object.keys(tool.function.parameters.properties)).toEqual(
        Object.keys(schema),
      );
    }
  });

  it("advertises the same list and number limits that are enforced", () => {
    for (const tool of tools)
      for (const value of Object.values(tool.function.parameters.properties)) {
        const schema = value as { type: string; maxItems?: number };

        expect(schema.type).not.toBe("number");
        if (schema.type === "array") expect(schema.maxItems).toBe(100);
        if (schema.type === "integer")
          expect(value).toEqual({ type: "integer", minimum: 0 });
      }
  });

  it("describes every tool in its own words", () => {
    for (const tool of tools) {
      expect(tool.function.description).not.toBe(tool.function.name);
      expect(tool.function.description.length).toBeGreaterThan(20);
    }
  });

  it("accepts a call built from only the required arguments of each tool", () => {
    const sample: Record<string, unknown> = {
      string: "x",
      markdown: "x",
      array: [],
      number: 1,
      boolean: true,
    };

    for (const [name, schema] of Object.entries(definitions)) {
      const input = Object.fromEntries(
        Object.entries(schema)
          .filter(([, type]) => !type.endsWith("?"))
          .map(([key, type]) => [key, sample[type]]),
      );

      expect(() => validateCall(name, input), name).not.toThrow();
    }
  });
});
