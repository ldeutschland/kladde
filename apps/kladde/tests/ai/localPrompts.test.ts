import { describe, expect, it } from "vitest";
import {
  answerOnlyInstructions,
  localBudget,
  localInstructions,
  replyLanguage,
} from "../../src/ai/localPrompts";
import type { PromptContext } from "../../src/ai/prompts";

const CONTEXT_TOKENS = 8192;
const context: PromptContext = {
  mode: "auto",
  web: false,
  instructions: [],
  template: null,
  memories: [],
  memoryAuto: false,
  today: "2026-11-28",
};

describe("local reply language", () => {
  it("names German and English", () => {
    expect(replyLanguage("de")).toBe("German");
    expect(replyLanguage("en")).toBe("English");
  });

  it("falls back to English for any other code", () => {
    const others = [
      "",
      "fr",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
    ];

    expect(others.map((code) => replyLanguage(code))).toEqual(
      others.map(() => "English"),
    );
  });

  it("tells the model to keep the language after tool calls", () => {
    const rule = "- Always reply in German, also after tool calls.";
    const agent = localInstructions(
      context,
      localBudget(CONTEXT_TOKENS),
      "German",
    );
    const notes = answerOnlyInstructions(context, "German");

    expect(agent.split("\n")).toContain(rule);
    expect(notes.split("\n")).toContain(rule);
    expect(agent).not.toContain("English");
  });
});
