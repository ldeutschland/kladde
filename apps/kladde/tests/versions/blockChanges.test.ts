import { describe, expect, it } from "vitest";
import {
  compareBlocks,
  indexBlocks,
  type Block,
} from "../../src/versions/blockChanges";

type Tree = [string, string, Tree[]?];

function build([id, text, children = []]: Tree): Block {
  return {
    id,
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: children.map(build),
  } as unknown as Block;
}

function changed(before: Tree[], after: Tree[]) {
  const { changes } = compareBlocks(
    indexBlocks(before.map(build)),
    indexBlocks(after.map(build)),
  );

  return changes.map(({ id, left, right }) => ({
    id,
    kind: !left ? "added" : !right ? "removed" : "changed",
  }));
}

describe("indexing blocks", () => {
  it("records every nested block with its parent and sibling list", () => {
    const list = [build(["a", "A", [["b", "B", [["c", "C"]]]]])];
    const index = indexBlocks(list);

    expect([...index.keys()]).toEqual(["a", "b", "c"]);
    expect(index.get("a")).toMatchObject({ parent: "", siblings: list });
    expect(index.get("c")?.parent).toBe("b");
    expect(index.get("c")?.siblings).toBe(index.get("b")?.block.children);
  });
});

describe("comparing versions block by block", () => {
  it("finds nothing when the versions are equal", () => {
    const tree: Tree[] = [
      ["a", "A", [["b", "B"]]],
      ["c", "C"],
    ];

    expect(changed(tree, structuredClone(tree))).toEqual([]);
  });

  it("reports an inserted block without flagging the blocks after it", () => {
    expect(
      changed(
        [
          ["a", "A"],
          ["b", "B"],
        ],
        [
          ["a", "A"],
          ["n", "neu"],
          ["b", "B"],
        ],
      ),
    ).toEqual([{ id: "n", kind: "added" }]);
  });

  it("reports a deleted block without flagging the blocks after it", () => {
    expect(
      changed(
        [
          ["a", "A"],
          ["x", "weg"],
          ["b", "B"],
        ],
        [
          ["a", "A"],
          ["b", "B"],
        ],
      ),
    ).toEqual([{ id: "x", kind: "removed" }]);
  });

  it("reports an edited block but not its unchanged parent", () => {
    const before: Tree[] = [["p", "Eltern", [["c", "alt"]]]];
    const after: Tree[] = [["p", "Eltern", [["c", "neu"]]]];

    expect(changed(before, after)).toEqual([{ id: "c", kind: "changed" }]);
  });

  it("reports both blocks of a swap and leaves the rest alone", () => {
    const before: Tree[] = [
      ["a", "A"],
      ["b", "B"],
      ["c", "C"],
    ];
    const after: Tree[] = [
      ["b", "B"],
      ["a", "A"],
      ["c", "C"],
    ];

    expect(
      changed(before, after)
        .map((change) => change.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("reports a block moved into another parent", () => {
    const before: Tree[] = [
      ["p", "P"],
      ["m", "M"],
    ];
    const after: Tree[] = [["p", "P", [["m", "M"]]]];

    expect(changed(before, after)).toEqual([{ id: "m", kind: "changed" }]);
  });

  it("reports a removed branch once, not every block inside it", () => {
    const before: Tree[] = [
      ["p", "P", [["c", "C", [["g", "G"]]]]],
      ["s", "S"],
    ];

    expect(changed(before, [["s", "S"]])).toEqual([
      { id: "p", kind: "removed" },
    ]);
    expect(changed([["s", "S"]], before)).toEqual([{ id: "p", kind: "added" }]);
  });

  it("tells whether a common block kept its place among the others", () => {
    const previous = indexBlocks(
      [
        ["a", "A"],
        ["x", "X"],
        ["b", "B"],
      ].map((t) => build(t as Tree)),
    );
    const current = indexBlocks(
      [
        ["b", "B"],
        ["a", "A"],
      ].map((t) => build(t as Tree)),
    );
    const { samePlace } = compareBlocks(previous, current);

    expect(samePlace("a")).toBe(false);
    expect(samePlace("b")).toBe(false);

    const same = compareBlocks(
      previous,
      indexBlocks([build(["a", "A"]), build(["b", "B"])]),
    );

    expect(same.samePlace("a")).toBe(true);
    expect(same.samePlace("b")).toBe(true);
  });
});
