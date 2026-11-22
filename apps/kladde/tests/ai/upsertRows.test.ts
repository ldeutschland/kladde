import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestSpace } from "../support/agentFixture";

vi.mock("../../src/notebook/content", async (importOriginal) =>
  (await import("../support/plainContent")).plainContent(
    await importOriginal(),
  ),
);

const { addField, startAgent, testSpace } =
  await import("../support/agentFixture");

function notebook() {
  const space = testSpace();
  const db = space.add("db", "database", null);

  addField(db, { id: "f-notes", name: "Notes", type: "text", options: [] });
  addField(db, { id: "f-score", name: "Score", type: "number", options: [] });
  addField(db, { id: "f-done", name: "Done", type: "checkbox", options: [] });
  addField(db, {
    id: "f-link",
    name: "Link",
    type: "relation",
    options: [],
    target: "other",
  });
  space.add("row1", "row", "db");
  space.add("other", "database", null);
  space.add("o1", "row", "other");
  space.add("o2", "row", "other", { aiExcluded: true });
  space.add("elsewhere", "database", null);
  space.add("foreign", "row", "elsewhere");
  space.add("note", "page", null);

  return space;
}

function values(run: ReturnType<typeof startAgent>["run"], id: string) {
  const draft = run.changes.get(id);

  return draft?.copy.doc.getMap("properties").toJSON();
}

describe("Upserting rows", () => {
  let space: TestSpace;

  beforeEach(() => {
    space = notebook();
  });

  it("creates rows with values given by property name or id", async () => {
    const { run } = startAgent(space);
    const result = (await run.call("upsert_rows", {
      id: "db",
      rows: [
        {
          title: "Neu",
          values: { Notes: "hi", "f-score": 3, Done: true, Link: "o1" },
        },
      ],
    })) as { rows: string[] };

    expect(result.rows).toHaveLength(1);
    const [id] = result.rows;

    expect(run.changes.get(id)!.page).toMatchObject({
      title: "Neu",
      kind: "row",
      parent: "db",
    });
    expect(values(run, id)).toEqual({
      "f-notes": "hi",
      "f-score": "3",
      "f-done": "true",
      "f-link": "o1",
    });
    expect(
      run.changes.get("db")!.copy.doc.getArray("row_order").toArray(),
    ).toEqual([id]);
    expect(space.entries.get("db")!.doc.getArray("row_order").length).toBe(0);
  });

  it("updates an existing row of the same database", async () => {
    const { run } = startAgent(space);

    await run.call("upsert_rows", {
      id: "db",
      rows: [{ id: "row1", title: "Umbenannt", values: { Notes: "x" } }],
    });
    expect(run.changes.get("row1")!.page.title).toBe("Umbenannt");
    expect(values(run, "row1")).toEqual({ "f-notes": "x" });
  });

  it("refuses rows that belong to another database or are no rows", async () => {
    const { run } = startAgent(space);

    for (const id of ["foreign", "note", "other"])
      await expect(
        run.call("upsert_rows", { id: "db", rows: [{ id }] }),
        id,
      ).rejects.toThrow("Foreign row");
    expect(run.changes.size).toBe(0);
  });

  it("does not link rows that are excluded from AI or live elsewhere", async () => {
    const { run } = startAgent(space);

    await expect(
      run.call("upsert_rows", {
        id: "db",
        rows: [{ id: "row1", values: { Link: "o1,o2" } }],
      }),
    ).rejects.toThrow("Invalid relation");
    await expect(
      run.call("upsert_rows", {
        id: "db",
        rows: [{ id: "row1", values: { Link: "foreign" } }],
      }),
    ).rejects.toThrow("Invalid relation");
    expect(run.changes.size).toBe(0);
  });

  it("rejects unknown and prototype property keys", async () => {
    const { run } = startAgent(space);

    for (const key of ["Missing", "__proto__", "constructor", "toString"]) {
      const rows = [{ id: "row1", values: JSON.parse(`{"${key}":"x"}`) }];

      await expect(
        run.call("upsert_rows", { id: "db", rows }),
        key,
      ).rejects.toThrow("Unknown property");
    }
  });

  it("rejects values that do not fit the property", async () => {
    const { run } = startAgent(space);
    const cases: [Record<string, unknown>, string][] = [
      [{ Score: "viel" }, "Invalid number"],
      [{ Done: "ja" }, "Invalid checkbox"],
      [{ Notes: { text: "x" } }, "Invalid text"],
      [{ Notes: ["x"] }, "Invalid text"],
      [{ Notes: "x".repeat(8193) }, "Invalid text"],
    ];

    for (const [given, message] of cases)
      await expect(
        run.call("upsert_rows", {
          id: "db",
          rows: [{ id: "row1", values: given }],
        }),
        JSON.stringify(given).slice(0, 40),
      ).rejects.toThrow(message);
  });

  it("needs a title for new rows", async () => {
    const { run } = startAgent(space);

    await expect(
      run.call("upsert_rows", { id: "db", rows: [{ values: {} }] }),
    ).rejects.toThrow("Invalid text");
    await expect(
      run.call("upsert_rows", { id: "db", rows: [{ title: " " }] }),
    ).rejects.toThrow("Invalid page");
  });

  it("drops every row of a call when one row fails", async () => {
    const { run } = startAgent(space);

    await expect(
      run.call("upsert_rows", {
        id: "db",
        rows: [
          { title: "Gut", values: { Notes: "ok" } },
          { id: "row1", values: { Score: "kaputt" } },
        ],
      }),
    ).rejects.toThrow("Invalid number");
    expect(run.changes.size).toBe(0);
  });

  it("rejects row entries that are not objects", async () => {
    const { run } = startAgent(space);

    await expect(
      run.call("upsert_rows", { id: "db", rows: ["row1"] }),
    ).rejects.toThrow("Invalid object");
  });
});
