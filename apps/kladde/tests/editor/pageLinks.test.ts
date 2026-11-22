import { describe, expect, it, vi } from "vitest";
import type { BlockNoteEditor } from "@blocknote/core";
import type { Notebook } from "../../src/notebook/notebook";
import type { T } from "../../src/locale/locale";
import { pageSuggestions } from "../../src/editor/pageLinks";

const MENTION_RESULTS = 30;
const t = ((key: string) => key) as T;

function fakeBook(pages: { id: string; title: string; archived?: number }[]) {
  return {
    pages: new Map(pages.map((page) => [page.id, { archived: null, ...page }])),
  } as unknown as Notebook;
}

function fakeEditor() {
  const editor = { insertInlineContent: vi.fn() };

  return { editor, asEditor: editor as unknown as BlockNoteEditor };
}

describe("page mentions", () => {
  it("matches titles case-insensitively and leaves out trashed pages", () => {
    const book = fakeBook([
      { id: "1", title: "Reiseplanung" },
      { id: "2", title: "Alte REISE", archived: 5 },
      { id: "3", title: "Einkauf" },
    ]);
    const { asEditor } = fakeEditor();
    const titles = pageSuggestions(asEditor, book, t, "reise").map(
      (item) => item.title,
    );

    expect(titles).toEqual(["Reiseplanung"]);
  });

  it("caps the number of suggestions", () => {
    const book = fakeBook(
      Array.from({ length: MENTION_RESULTS + 5 }, (_, i) => ({
        id: `p${i}`,
        title: `Seite ${i}`,
      })),
    );
    const { asEditor } = fakeEditor();

    expect(pageSuggestions(asEditor, book, t, "")).toHaveLength(
      MENTION_RESULTS,
    );
  });

  it("inserts an internal link named after the page, untitled ones included", () => {
    const book = fakeBook([{ id: "abc", title: "" }]);
    const { editor, asEditor } = fakeEditor();
    const [suggestion] = pageSuggestions(asEditor, book, t, "");

    expect(suggestion.title).toBe("untitled");
    suggestion.onItemClick();
    expect(editor.insertInlineContent).toHaveBeenCalledWith([
      { type: "link", href: "kladde:abc", content: "untitled" },
    ]);
  });
});
