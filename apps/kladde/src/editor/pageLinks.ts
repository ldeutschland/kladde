import type { BlockNoteEditor } from "@blocknote/core";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { NotebookEditor } from "./schema";

const MENTION_RESULTS = 30;

type Place = "before" | "after";

function pageLinkContent(id: string) {
  return { type: "pageLink" as const, props: { page: id } };
}

function withPageLinks(editor: BlockNoteEditor) {
  return editor as unknown as NotebookEditor;
}

export function insertPageLink(editor: BlockNoteEditor, id: string) {
  withPageLinks(editor).insertInlineContent([pageLinkContent(id), " "]);
}

export function insertPageParagraph(
  editor: BlockNoteEditor,
  id: string,
  reference: string,
  place: Place,
) {
  const [inserted] = withPageLinks(editor).insertBlocks(
    [{ type: "paragraph", content: [pageLinkContent(id)] }],
    reference,
    place,
  );

  return inserted;
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
      (page) =>
        !page.archived &&
        page.kind !== "chat" &&
        page.title.toLowerCase().includes(needle),
    )
    .slice(0, MENTION_RESULTS)
    .map((page) => ({
      title: page.title || t("untitled"),
      onItemClick: () => insertPageLink(editor, page.id),
    }));
}
