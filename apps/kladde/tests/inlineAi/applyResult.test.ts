import { describe, expect, it } from "vitest";
import type { BlockNoteEditor } from "@blocknote/core";
import {
  insertBelowSelection,
  replaceSelection,
} from "../../src/inlineAi/applyResult";
import type { InlineStart } from "../../src/inlineAi/actions";

type Blocks = Parameters<typeof replaceSelection>[2];

interface FakeBlock {
  id: string;
  type: string;
  content?: unknown;
}

function fakeEditor(document: FakeBlock[]) {
  const actions: unknown[][] = [];
  const editor = {
    getBlock: (id: string) => document.find((block) => block.id === id),
    insertInlineContent: (content: unknown) =>
      actions.push(["inline", content]),
    replaceBlocks: (old: unknown[], blocks: unknown[]) =>
      actions.push(["replace", old, blocks]),
    insertBlocks: (blocks: unknown[], anchor: FakeBlock, place: string) =>
      actions.push(["insert", blocks, anchor.id, place]),
  };

  return { editor: editor as unknown as BlockNoteEditor, actions };
}

function result(...blocks: FakeBlock[]) {
  return blocks as unknown as Blocks;
}

const paragraph = { id: "n", type: "paragraph", content: [{ text: "neu" }] };
const heading = { id: "h", type: "heading", content: [{ text: "Titel" }] };

function start(patch: Partial<InlineStart>): InlineStart {
  return { top: 0, selection: "alt", blocks: ["a", "b"], ...patch };
}

describe("Replacing the selection", () => {
  it("inserts a single paragraph inline to keep the surrounding block", () => {
    const { editor, actions } = fakeEditor([]);

    replaceSelection(editor, start({}), result(paragraph));
    expect(actions).toEqual([["inline", paragraph.content]]);
  });

  it("replaces the selected blocks with structured results", () => {
    const { editor, actions } = fakeEditor([]);

    replaceSelection(editor, start({}), result(heading));
    replaceSelection(editor, start({}), result(paragraph, paragraph));
    expect(actions).toEqual([
      ["replace", ["a", "b"], [heading]],
      ["replace", ["a", "b"], [paragraph, paragraph]],
    ]);
  });
});

describe("Inserting below the selection", () => {
  it("inserts after the last selected block", () => {
    const { editor, actions } = fakeEditor([
      { id: "a", type: "paragraph", content: [{ text: "x" }] },
      { id: "b", type: "paragraph", content: [{ text: "y" }] },
    ]);

    expect(insertBelowSelection(editor, start({}), result(heading))).toBe(true);
    expect(actions).toEqual([["insert", [heading], "b", "after"]]);
  });

  it("fills an empty paragraph when nothing was selected", () => {
    const empty = { id: "b", type: "paragraph", content: [] };
    const { editor, actions } = fakeEditor([empty]);

    insertBelowSelection(editor, start({ selection: "" }), result(heading));
    insertBelowSelection(editor, start({}), result(heading));
    expect(actions).toEqual([
      ["replace", [empty], [heading]],
      ["insert", [heading], "b", "after"],
    ]);
  });

  it("does nothing when the anchor block is gone", () => {
    const { editor, actions } = fakeEditor([]);

    expect(insertBelowSelection(editor, start({}), result(heading))).toBe(
      false,
    );
    expect(actions).toEqual([]);
  });
});
