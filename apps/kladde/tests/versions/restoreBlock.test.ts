import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import type { Entry } from "../../src/notebook/notebook";
import { translator } from "../../src/locale/locale";
import {
  compareBlocks,
  indexBlocks,
  type Block,
} from "../../src/versions/blockChanges";

vi.mock("../../src/notebook/content", async (importOriginal) =>
  (await import("../support/plainContent")).plainContent(
    await importOriginal(),
  ),
);

const { blockEditor, blocks } = await import("../../src/notebook/content");
const { restoreBlock } = await import("../../src/versions/restoreBlock");

type Tree = [string, string, Tree[]?];

const FILE = "3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f";

function build([id, text, children = []]: Tree): Block {
  return {
    id,
    type: "paragraph",
    content: text,
    children: children.map(build),
  } as unknown as Block;
}

function entry(tree: Tree[]): Entry {
  const doc = new Y.Doc();

  blocksToYXmlFragment(
    blockEditor(),
    tree.map(build),
    doc.getXmlFragment("blocks"),
  );

  return { id: "page", doc, rev: 1, kind: "page" };
}

function outline(list: Block[]): string[] {
  return list.flatMap((block) => {
    const text = (block.content as { text: string }[])
      .map((part) => part.text)
      .join("");

    return [
      block.id + ":" + text,
      ...outline(block.children).map((line) => "  " + line),
    ];
  });
}

function restore(old: Entry, current: Entry, id: string) {
  const previous = indexBlocks(blocks(old));
  const { samePlace } = compareBlocks(previous, indexBlocks(blocks(current)));
  const t = translator("en");
  const done = restoreBlock(
    { entry: current, old, previous, samePlace, t },
    id,
  );

  return { done, lines: outline(blocks(current)) };
}

describe("restoring a single block", () => {
  it("puts a deleted block back after the block that preceded it", () => {
    const old = entry([
      ["a", "A"],
      ["x", "weg"],
      ["b", "B"],
    ]);
    const current = entry([
      ["n", "neu"],
      ["a", "A"],
      ["b", "B"],
    ]);

    expect(restore(old, current, "x")).toEqual({
      done: true,
      lines: ["n:neu", "a:A", "x:weg", "b:B"],
    });
  });

  it("puts a deleted first block back at the top", () => {
    const old = entry([
      ["x", "weg"],
      ["a", "A"],
    ]);
    const current = entry([["a", "A"]]);

    expect(restore(old, current, "x").lines).toEqual(["x:weg", "a:A"]);
  });

  it("reverts an edit in place and keeps the current children", () => {
    const old = entry([
      ["a", "A"],
      ["p", "alt"],
      ["b", "B"],
    ]);
    const current = entry([
      ["a", "A"],
      ["p", "neu", [["k", "Kind"]]],
      ["b", "B"],
    ]);

    expect(restore(old, current, "p").lines).toEqual([
      "a:A",
      "p:alt",
      "  k:Kind",
      "b:B",
    ]);
  });

  it("removes a block that did not exist in the version", () => {
    const old = entry([["a", "A"]]);
    const current = entry([
      ["a", "A"],
      ["n", "neu"],
    ]);

    expect(restore(old, current, "n").lines).toEqual(["a:A"]);
  });

  it("moves a block back to its former place", () => {
    const old = entry([
      ["a", "A"],
      ["b", "B"],
      ["c", "C"],
    ]);
    const current = entry([
      ["b", "B"],
      ["c", "C"],
      ["a", "A"],
    ]);

    expect(restore(old, current, "a").lines).toEqual(["a:A", "b:B", "c:C"]);
  });

  it("does nothing when the former parent no longer exists", () => {
    const old = entry([["p", "P", [["c", "Kind"]]]]);
    const current = entry([["q", "Q"]]);

    expect(restore(old, current, "c")).toEqual({ done: false, lines: ["q:Q"] });
  });

  it("asks to restore the parent first when it now sits inside the block", () => {
    const old = entry([["p", "P", [["c", "C"]]]]);
    const current = entry([["c", "C", [["p", "P"]]]]);
    const previous = indexBlocks(blocks(old));
    const { samePlace } = compareBlocks(previous, indexBlocks(blocks(current)));
    const context = {
      entry: current,
      old,
      previous,
      samePlace,
      t: translator("en"),
    };

    expect(() => restoreBlock(context, "c")).toThrow(
      "Restore the parent block first.",
    );
  });

  it("restores a deleted parent without duplicating children that live elsewhere", () => {
    const old = entry([
      [
        "p",
        "P",
        [
          ["k", "bleibt"],
          ["g", "weg"],
        ],
      ],
      ["s", "S"],
    ]);
    const current = entry([
      ["s", "S"],
      ["k", "bleibt"],
    ]);

    expect(restore(old, current, "p").lines).toEqual([
      "p:P",
      "  g:weg",
      "s:S",
      "k:bleibt",
    ]);
  });

  it("brings back file metadata referenced by the restored block and the text", () => {
    const old = entry([
      ["a", "A"],
      ["f", `[Datei](kladde-file:${FILE})`],
    ]);
    const meta = { type: "application/pdf", name: "a.pdf", size: 3 };

    old.doc.getMap("files").set(FILE, meta);
    const current = entry([["a", "A"]]);

    restore(old, current, "f");
    expect(current.doc.getMap("files").get(FILE)).toEqual(meta);
    expect(String(current.doc.getMap("meta").get("text"))).toContain("Datei");
  });
});
