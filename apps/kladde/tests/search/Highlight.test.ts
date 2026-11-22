import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { Highlight } from "../../src/search/Highlight";

type Part = string | ReactElement<{ children: string }>;

function marked(text: string, query: string) {
  const parts = Highlight({ text, query }) as Part[] | string;

  if (typeof parts === "string") return [];

  return parts
    .filter((part): part is Exclude<Part, string> => typeof part !== "string")
    .map((part) => {
      expect(part.type).toBe("mark");

      return part.props.children;
    });
}

describe("highlighting search terms", () => {
  it("returns the text untouched for an empty query", () => {
    expect(Highlight({ text: "Inhalt", query: "  " })).toBe("Inhalt");
  });

  it("marks every term case-insensitively, including non-ASCII letters", () => {
    expect(marked("Ärger über ÄRGER und Öl", 'ärger ÜBER "öl"')).toEqual([
      "Ärger",
      "über",
      "ÄRGER",
      "Öl",
    ]);
  });

  it("keeps the whole text in order", () => {
    const parts = Highlight({
      text: "eins zwei eins",
      query: "eins",
    }) as Part[];
    const joined = parts
      .map((part) => (typeof part === "string" ? part : part.props.children))
      .join("");

    expect(joined).toBe("eins zwei eins");
  });

  it("prefers the longer term when terms overlap", () => {
    expect(marked("Notizbuch", "Notiz Notizbuch")).toEqual(["Notizbuch"]);
  });

  it("treats regular expression syntax in the query literally", () => {
    expect(marked("axb a.b (x) [y]", "a.b (x) [y]")).toEqual([
      "a.b",
      "(x)",
      "[y]",
    ]);
    expect(marked("aaaa", "a+")).toEqual([]);
    expect(marked("backslash \\d", "\\d")).toEqual(["\\d"]);
  });
});
