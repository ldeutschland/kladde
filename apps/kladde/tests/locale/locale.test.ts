import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  aiLanguage,
  LANGUAGE_CHOICES,
  setAiLanguage,
  translator,
  type Word,
} from "../../src/locale/locale";
import type { Notebook } from "../../src/notebook/notebook";

const SOURCE = readFileSync(
  new URL("../../src/locale/locale.ts", import.meta.url),
  "utf8",
);
const KEYS = [...SOURCE.matchAll(/^ {2}(\w+): \[/gm)].map(
  (match) => match[1] as Word,
);
const german = translator("de");
const english = translator("en");

function placeholders(text: string) {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe("translations", () => {
  it("finds the whole word list in the source", () => {
    expect(KEYS.length).toBeGreaterThan(500);
    expect(new Set(KEYS).size).toBe(KEYS.length);
  });

  it("has a non-empty German and English text for every word", () => {
    const missing = KEYS.filter(
      (key) =>
        typeof german(key) !== "string" ||
        typeof english(key) !== "string" ||
        !german(key).trim() ||
        !english(key).trim(),
    );

    expect(missing).toEqual([]);
  });

  it("uses the same placeholders in both languages", () => {
    const mismatched = KEYS.filter(
      (key) =>
        placeholders(german(key)).join() !== placeholders(english(key)).join(),
    );

    expect(mismatched).toEqual([]);
  });

  it("has no stray braces outside placeholders", () => {
    const stray = KEYS.filter((key) =>
      [german(key), english(key)].some((text) =>
        /[{}]/.test(text.replace(/\{\w+\}/g, "")),
      ),
    );

    expect(stray).toEqual([]);
  });

  it("speaks English only for English and German otherwise", () => {
    expect(translator("en")("zoomIn")).toBe("Zoom in");
    expect(translator("de")("zoomIn")).toBe("Vergrößern");
    expect(translator("fr")("zoomIn")).toBe("Vergrößern");
    expect(translator("")("zoomIn")).toBe("Vergrößern");
  });
});

const AI_LANGUAGE_KEY = "aiLanguage";

function bookWith(settings: Record<string, unknown> = {}) {
  const map = new Y.Doc().getMap<unknown>("settings");

  for (const [key, value] of Object.entries(settings)) map.set(key, value);

  return { settings: map } as unknown as Notebook;
}

describe("AI language", () => {
  it("offers German and English", () => {
    expect(LANGUAGE_CHOICES.map((choice) => choice.value)).toEqual([
      "de",
      "en",
    ]);
  });

  it("follows the app language until one is chosen", () => {
    expect(aiLanguage(bookWith())).toBe("");
  });

  it("stores German and English", () => {
    const book = bookWith();

    setAiLanguage(book, "en");
    expect(aiLanguage(book)).toBe("en");
    setAiLanguage(book, "de");
    expect(aiLanguage(book)).toBe("de");
    expect(book.settings.get(AI_LANGUAGE_KEY)).toBe("de");
  });

  it("forgets the choice for anything else", () => {
    const book = bookWith();

    for (const language of ["", "fr", "EN", "constructor", "__proto__"]) {
      setAiLanguage(book, "de");
      setAiLanguage(book, language);
      expect(book.settings.has(AI_LANGUAGE_KEY)).toBe(false);
      expect(aiLanguage(book)).toBe("");
    }
  });

  it("ignores stored values it does not know", () => {
    const stored: unknown[] = ["fr", "", 1, true, null, ["de"], { de: "de" }];

    for (const value of stored)
      expect(aiLanguage(bookWith({ [AI_LANGUAGE_KEY]: value }))).toBe("");
  });
});
