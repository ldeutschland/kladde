import { describe, expect, it, vi } from "vitest";
import type { BlockNoteEditor } from "@blocknote/core";
import {
  appendFiles,
  insertFileAtCursor,
  isEmptyParagraph,
} from "../../src/editor/fileBlocks";

interface Block {
  id: string;
  type: string;
  content?: unknown;
  props?: Record<string, unknown>;
}

function fakeEditor(
  document: Block[],
  upload: (file: File, id: string) => Promise<string>,
) {
  let next = 0;
  const editor = {
    document,
    uploadFile: vi.fn(upload),
    getBlock: (id: string) => document.find((block) => block.id === id),
    getTextCursorPosition: () => ({ block: document[0] }),
    updateBlock: vi.fn((target: Block | string, patch: Partial<Block>) => {
      const id = typeof target === "string" ? target : target.id;
      const block = document.find((item) => item.id === id)!;

      Object.assign(block, patch, {
        props: { ...block.props, ...patch.props },
      });

      return block;
    }),
    insertBlocks: vi.fn((blocks: Block[], anchor: Block) => {
      const created = blocks.map((block) => ({ ...block, id: `new${++next}` }));

      document.splice(document.indexOf(anchor) + 1, 0, ...created);

      return created;
    }),
  };

  return { editor, asEditor: editor as unknown as BlockNoteEditor };
}

function file(name: string, type: string) {
  return new File(["x"], name, { type });
}

describe("file blocks", () => {
  it("treats only a paragraph without content as empty", () => {
    expect(isEmptyParagraph({ type: "paragraph", content: [] })).toBe(true);
    expect(isEmptyParagraph({ type: "paragraph", content: [{}] })).toBe(false);
    expect(isEmptyParagraph({ type: "paragraph" })).toBe(false);
    expect(isEmptyParagraph({ type: "paragraph", content: "" })).toBe(false);
    expect(isEmptyParagraph({ type: "heading", content: [] })).toBe(false);
  });

  it("fills a trailing empty paragraph and appends further files after it", async () => {
    const document: Block[] = [{ id: "p", type: "paragraph", content: [] }];
    const { editor, asEditor } = fakeEditor(
      document,
      async (_, id) => `u:${id}`,
    );

    await appendFiles(asEditor, [
      file("a.png", "image/png"),
      file("b.pdf", "application/pdf"),
    ]);
    expect(document.map((block) => [block.id, block.type])).toEqual([
      ["p", "image"],
      ["new1", "file"],
    ]);
    expect(document[0].props).toEqual({ name: "a.png", url: "u:p" });
    expect(document[1].props).toEqual({ name: "b.pdf", url: "u:new1" });
    expect(editor.insertBlocks).toHaveBeenCalledTimes(1);
  });

  it("keeps the block without an address when the upload fails", async () => {
    const document: Block[] = [{ id: "t", type: "paragraph", content: ["x"] }];
    const { asEditor } = fakeEditor(document, async () => {
      throw Error("disk full");
    });

    await expect(
      insertFileAtCursor(asEditor, file("a.txt", "text/plain")),
    ).resolves.toBeUndefined();
    expect(document[1].props).toEqual({ name: "a.txt" });
  });

  it("does not touch a block that was deleted during the upload", async () => {
    const document: Block[] = [{ id: "p", type: "paragraph", content: [] }];
    const { editor, asEditor } = fakeEditor(document, async () => {
      document.length = 0;

      return "late";
    });

    await insertFileAtCursor(asEditor, file("a.png", "image/png"));
    expect(editor.updateBlock).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty document", async () => {
    const { editor, asEditor } = fakeEditor([], async () => "u");

    await appendFiles(asEditor, [file("a.png", "image/png")]);
    expect(editor.uploadFile).not.toHaveBeenCalled();
  });
});
