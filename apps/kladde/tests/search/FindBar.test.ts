import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIND_QUERY_LENGTH,
  findableQuery,
  selectedQuery,
} from "../../src/search/FindBar";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("text to find", () => {
  it("trims the text", () => {
    expect(findableQuery("  Betrag \t")).toBe("Betrag");
  });

  it("skips text on several lines or longer than the find field", () => {
    const longest = "a".repeat(FIND_QUERY_LENGTH);

    expect(findableQuery("Rechnung\nBetrag")).toBe("");
    expect(findableQuery(longest + "a")).toBe("");
    expect(findableQuery(longest)).toBe(longest);
  });

  it("takes the selected text if there is any", () => {
    vi.stubGlobal("getSelection", () => ({ toString: () => " 4711 " }));
    expect(selectedQuery()).toBe("4711");
    vi.stubGlobal("getSelection", () => null);
    expect(selectedQuery()).toBe("");
  });
});
