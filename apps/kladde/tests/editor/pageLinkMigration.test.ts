import { describe, expect, it, vi } from "vitest";
import { BlockNoteEditor, BlockNoteSchema } from "@blocknote/core";
import { pageLinkSpec } from "../../src/editor/pageLinkSpec";
import { convertPageLinks } from "../../src/editor/usePageLinkMigration";

const PAGE = "3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f";
const OTHER = "0b1c2d3e-4f50-4617-8a9b-cdef01234567";
const schema = BlockNoteSchema.create().extend({
  inlineContentSpecs: { pageLink: pageLinkSpec },
});

type Styled = { type: "text"; text: string; styles: { bold?: true } };
type Linked = { type: "link"; href: string; content: string | Styled[] };

function link(href: string, content: string | Styled[]): Linked {
  return { type: "link", href, content };
}

function editorWith(...content: (string | Linked)[]) {
  return BlockNoteEditor.create({
    schema,
    initialContent: [{ type: "paragraph", content }],
  });
}

function converted(...content: (string | Linked)[]) {
  const editor = editorWith(...content);

  convertPageLinks(editor as unknown as BlockNoteEditor);

  return { editor, content: editor.document[0].content };
}

function reference(page: string) {
  return { type: "pageLink", props: { page } };
}

function text(value: string) {
  return { type: "text", text: value, styles: {} };
}

describe("migrating stored page links", () => {
  it("turns links to pages into references and keeps the text around them", () => {
    const { content } = converted(
      "Alt ",
      link("kladde:" + PAGE, "Ohne Titel"),
      " Ende",
    );

    expect(content).toEqual([text("Alt "), reference(PAGE), text(" Ende")]);
  });

  it("joins a link split by formatting into one reference", () => {
    const { content } = converted(
      link("kladde:" + PAGE, [
        { type: "text", text: "Ohne ", styles: {} },
        { type: "text", text: "Titel", styles: { bold: true } },
      ]),
    );

    expect(content).toEqual([reference(PAGE)]);
  });

  it("keeps web links and links to different pages apart", () => {
    const { content } = converted(
      link("https://example.org", "Web"),
      " ",
      link("kladde:" + PAGE, "A"),
      link("kladde:" + OTHER, "B"),
    );

    expect(content).toEqual([
      {
        type: "link",
        href: "https://example.org",
        content: [text("Web")],
      },
      text(" "),
      reference(PAGE),
      reference(OTHER),
    ]);
  });

  it("normalises slashed and upper case page links", () => {
    const { content } = converted(
      link(`kladde://${PAGE.toUpperCase()}/`, "Alt"),
    );

    expect(content).toEqual([reference(PAGE)]);
  });

  it("leaves links that only look like page links alone", () => {
    const { content } = converted(
      link(`kladde:${PAGE}/../geheim`, "A"),
      link(`kladde-file:${PAGE}`, "B"),
    );

    expect(content).toEqual([
      { type: "link", href: `kladde:${PAGE}/../geheim`, content: [text("A")] },
      { type: "link", href: `kladde-file:${PAGE}`, content: [text("B")] },
    ]);
  });

  it("keeps the conversion out of the undo history", () => {
    const editor = editorWith(link("kladde:" + PAGE, "Alt"));
    const transact = editor.transact.bind(editor);
    const history: unknown[] = [];

    vi.spyOn(editor, "transact").mockImplementation((change) =>
      transact((tr) => {
        const result = change(tr);

        history.push(tr.getMeta("addToHistory"));

        return result;
      }),
    );
    convertPageLinks(editor as unknown as BlockNoteEditor);
    expect(history).toEqual([false]);
    expect(editor.document[0].content).toEqual([reference(PAGE)]);
  });

  it("does not touch documents without page links", () => {
    const editor = editorWith("Nur Text ", link("https://example.org", "Web"));
    const transact = vi.spyOn(editor, "transact");

    convertPageLinks(editor as unknown as BlockNoteEditor);
    expect(transact).not.toHaveBeenCalled();
  });
});
