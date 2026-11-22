import { describe, expect, it } from "vitest";
import { placementOf, savedChanges } from "../../src/ai/aiUndo";
import { freshPage } from "../../src/notebook/notebook";

const PAGE = "0b9d2f6e-3c1a-4e57-9a40-2f1c8d7e6b5a";
const PARENT = "7a1e4c90-5b2d-4f38-8c6e-9d0a1b2c3d4e";

describe("Saved AI changes", () => {
  it("keeps a complete record as it was written", () => {
    const record = {
      id: PAGE,
      title: "Notiz",
      created: false,
      rev: 4,
      after: 6,
      before: { title: "Alt", icon: "📝", parent: PARENT, archived: null },
    };

    expect(savedChanges(JSON.parse(JSON.stringify([record])))).toEqual([
      record,
    ]);
  });

  it("drops records without a page ID and anything that is no list", () => {
    const forged = [
      { id: "../secret", rev: 1 },
      { id: PAGE.toUpperCase(), rev: 1 },
      { rev: 1 },
      "text",
      null,
    ];

    expect(savedChanges(forged)).toEqual([]);
    expect(savedChanges({ 0: { id: PAGE } })).toEqual([]);
    expect(savedChanges(undefined)).toEqual([]);
  });

  it("accepts only positive whole revisions and a strict created flag", () => {
    const [change] = savedChanges([
      { id: PAGE, title: 5, created: "true", rev: -4, after: "9" },
    ]);

    expect(change).toEqual({
      id: PAGE,
      title: "",
      created: false,
      rev: null,
      after: 0,
      before: null,
    });
    expect(savedChanges([{ id: PAGE, rev: 1.5, after: 2 ** 60 }])[0]).toEqual(
      expect.objectContaining({ rev: null, after: 0 }),
    );
  });

  it("cleans the remembered placement", () => {
    const before = (value: unknown) =>
      savedChanges([{ id: PAGE, before: value }])[0].before;

    expect(before({ title: "T" })).toBeNull();
    expect(before({ title: 1, icon: "" })).toBeNull();
    expect(
      before({
        title: "x".repeat(500),
        icon: "y".repeat(500),
        parent: "elsewhere",
        archived: -1,
      }),
    ).toEqual({
      title: "x".repeat(200),
      icon: "y".repeat(64),
      parent: null,
      archived: null,
    });
    expect(
      before({ title: "T", icon: "", parent: PARENT, archived: 1700 }),
    ).toEqual({ title: "T", icon: "", parent: PARENT, archived: 1700 });
  });

  it("limits how many records one answer may carry", () => {
    const many = Array.from({ length: 3005 }, () => ({ id: PAGE }));

    expect(savedChanges(many)).toHaveLength(3000);
  });

  it("remembers where a page was before the change", () => {
    const page = { ...freshPage(PAGE, "Notiz", "page", PARENT), icon: "📝" };

    expect(placementOf(page)).toEqual({
      title: "Notiz",
      icon: "📝",
      parent: PARENT,
      archived: null,
    });
  });
});
