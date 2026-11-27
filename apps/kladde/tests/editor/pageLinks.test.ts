import { describe, expect, it, vi } from "vitest";
import type { BlockNoteEditor } from "@blocknote/core";
import type { Notebook } from "../../src/notebook/notebook";
import type { T } from "../../src/locale/locale";
import {
  insertPageParagraph,
  pageSuggestions,
} from "../../src/editor/pageLinks";

const MENTION_RESULTS = 30;
const t = ((key: string) => key) as T;

function fakeBook(
  pages: { id: string; title: string; archived?: number; kind?: string }[],
) {
  return {
    pages: new Map(pages.map((page) => [page.id, { archived: null, ...page }])),
  } as unknown as Notebook;
}

function fakeEditor() {
  const editor = {
    insertInlineContent: vi.fn(),
    insertBlocks: vi.fn((blocks: unknown[]) =>
      blocks.map((block, index) => ({
        id: "neu" + index,
        ...(block as object),
      })),
    ),
  };

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

  it("leaves AI chats out of the suggestions", () => {
    const book = fakeBook([
      { id: "1", title: "Reise", kind: "page" },
      { id: "2", title: "Reise besprechen", kind: "chat" },
    ]);
    const { asEditor } = fakeEditor();
    const titles = pageSuggestions(asEditor, book, t, "reise").map(
      (item) => item.title,
    );

    expect(titles).toEqual(["Reise"]);
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

  it("inserts a reference to the page instead of a copy of its title", () => {
    const book = fakeBook([{ id: "abc", title: "" }]);
    const { editor, asEditor } = fakeEditor();
    const [suggestion] = pageSuggestions(asEditor, book, t, "");

    expect(suggestion.title).toBe("untitled");
    suggestion.onItemClick();
    expect(editor.insertInlineContent).toHaveBeenCalledWith([
      { type: "pageLink", props: { page: "abc" } },
      " ",
    ]);
  });
});

describe("dropped pages", () => {
  it("become a paragraph holding a reference next to the target block", () => {
    const { editor, asEditor } = fakeEditor();
    const inserted = insertPageParagraph(asEditor, "abc", "block", "before");

    expect(editor.insertBlocks).toHaveBeenCalledWith(
      [
        {
          type: "paragraph",
          content: [{ type: "pageLink", props: { page: "abc" } }],
        },
      ],
      "block",
      "before",
    );
    expect(inserted.id).toBe("neu0");
  });
});
