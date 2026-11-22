import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translator, type Word } from "../../src/locale/locale";

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
