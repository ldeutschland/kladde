import type { BlockNoteEditor } from "@blocknote/core";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { pageLink } from "../notebook/links";

const MENTION_RESULTS = 30;

export function pageLinkContent(book: Notebook, t: T, id: string) {
  return {
    type: "link" as const,
    href: pageLink(id),
    content: book.pages.get(id)?.title || t("untitled"),
  };
}

export function insertPageLink(
  editor: BlockNoteEditor,
  book: Notebook,
  t: T,
  id: string,
) {
  editor.insertInlineContent([pageLinkContent(book, t, id)]);
}

export function pageSuggestions(
  editor: BlockNoteEditor,
  book: Notebook,
  t: T,
  query: string,
) {
  const needle = query.toLowerCase();

  return Array.from(book.pages.values())
    .filter(
      (page) => !page.archived && page.title.toLowerCase().includes(needle),
    )
    .slice(0, MENTION_RESULTS)
    .map((page) => ({
      title: page.title || t("untitled"),
      onItemClick: () => insertPageLink(editor, book, t, page.id),
    }));
}
