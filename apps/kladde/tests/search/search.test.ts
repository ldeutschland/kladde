import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  calls: [] as { name: string; args: Record<string, unknown> }[],
}));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: Record<string, unknown>) => {
    native.calls.push({ name, args });

    return { hits: [], pending: 0 };
  }),
}));

const { notebookCitation, readPassage, searchContent, searchTerms } =
  await import("../../src/search/search");

const DOC = "3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f";
const FILE = "0b1c2d3e-4f50-4617-8a9b-cdef01234567";

function hit(overrides: Record<string, unknown> = {}) {
  return {
    doc: DOC,
    file: FILE,
    name: "Bericht.pdf",
    snippet: "… der Bericht …",
    offset: 120,
    page: 3,
    ...overrides,
  };
}

beforeEach(() => {
  native.calls = [];
});

describe("search terms", () => {
  it("splits on any whitespace and treats quotes as separators", () => {
    expect(searchTerms('  "Grüne Bohnen"\tund\n„Erbsen“ ')).toEqual([
      "Grüne",
      "Bohnen",
      "und",
      "„Erbsen“",
    ]);
  });

  it("yields no terms for an empty or blank query", () => {
    expect(searchTerms("")).toEqual([]);
    expect(searchTerms(' \n\t"" ')).toEqual([]);
  });

  it("keeps at most sixteen terms", () => {
    const words = Array.from({ length: 40 }, (_, i) => "w" + i);

    expect(searchTerms(words.join(" "))).toEqual(words.slice(0, 16));
  });
});

describe("asking the core", () => {
  it("passes the query unchanged and leaves matching to the core", async () => {
    await searchContent("space", 'a "b" c', "parent");
    await readPassage("space", DOC, FILE, 42);
    expect(native.calls).toEqual([
      {
        name: "search_content",
        args: { space: "space", query: 'a "b" c', parent: "parent" },
      },
      {
        name: "read_attachment",
        args: { space: "space", doc: DOC, file: FILE, offset: 42, wait: false },
      },
    ]);
  });
});

describe("notebook citations", () => {
  it("keeps a valid citation and drops unknown fields", () => {
    const citation = notebookCitation({
      ...hit({ file: null }),
      matched: "<img src=x onerror=alert(1)>",
      html: "<b>x</b>",
    });

    expect(citation).toEqual({
      doc: DOC,
      file: null,
      name: "Bericht.pdf",
      snippet: "… der Bericht …",
      matched: "… der Bericht …",
      page: 3,
      offset: 120,
    });
  });

  it("accepts the bounds exactly", () => {
    const edge = hit({
      name: "n".repeat(255),
      snippet: "s".repeat(320),
      page: 1048575,
      offset: 8388608,
    });

    expect(notebookCitation(edge)).not.toBeNull();
    expect(notebookCitation(hit({ page: 0, offset: 0 }))).not.toBeNull();
  });

  it("rejects malformed or oversized citations", () => {
    const invalid = [
      null,
      "text",
      [],
      hit({ doc: DOC.toUpperCase() }),
      hit({ doc: "../" + DOC }),
      hit({ file: "Bericht.pdf" }),
      hit({ file: undefined }),
      hit({ name: 7 }),
      hit({ name: "n".repeat(256) }),
      hit({ snippet: "s".repeat(321) }),
      hit({ page: undefined }),
      hit({ page: -1 }),
      hit({ page: 1048576 }),
      hit({ page: 1.5 }),
      hit({ offset: "12" }),
      hit({ offset: 8388609 }),
      hit({ offset: Number.NaN }),
    ];

    for (const value of invalid)
      expect(notebookCitation(value), JSON.stringify(value)).toBeNull();
  });
});
