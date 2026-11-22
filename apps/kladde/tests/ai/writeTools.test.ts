import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/notebook/content", async (importOriginal) =>
  (await import("../support/plainContent")).plainContent(
    await importOriginal(),
  ),
);
vi.mock("../../src/notebook/pageMarkdown", async (importOriginal) =>
  (await import("../support/plainContent")).plainPageMarkdown(
    await importOriginal(),
  ),
);
vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string) => {
    if (name === "rows") return [[], null, 0];
    throw Error("Unexpected native command " + name);
  }),
}));

const { views } = await import("../../src/database/fields");
const {
  addField,
  blockIds,
  paragraphTexts,
  startAgent,
  testSpace,
  writeParagraphs,
} = await import("../support/agentFixture");

type Space = ReturnType<typeof testSpace>;

function notebook() {
  const space = testSpace();
  const note = space.add("note", "page", null);

  writeParagraphs(note, [
    ["b1", "one"],
    ["b2", "two"],
  ]);
  space.add("child", "page", "note");
  space.add("chat", "chat", null);
  const db = space.add("db", "database", null);

  addField(db, { id: "f-status", name: "Status", type: "status", options: [] });
  space.settings.set("aiRoot", "ai");
  space.add("ai", "page", null);
  space.add("rules", "page", "ai");

  return space;
}

function draftOf(run: ReturnType<typeof startAgent>["run"], id: string) {
  const draft = run.changes.get(id);

  if (!draft) throw Error("No draft for " + id);

  return draft;
}

describe("Write tools in propose mode", () => {
  let space: Space;

  beforeEach(() => {
    space = notebook();
  });

  it("writes into a draft and leaves the live page alone", async () => {
    const { run } = startAgent(space);
    const result = await run.call("append_to_page", {
      id: "note",
      markdown: "three",
    });

    expect(result).toMatchObject({ id: "note" });
    expect(paragraphTexts(draftOf(run, "note").copy)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(paragraphTexts(space.entries.get("note")!)).toEqual(["one", "two"]);
    expect(draftOf(run, "note").applied).toBe(false);
  });

  it("builds on the draft of an earlier call in the same run", async () => {
    const { run } = startAgent(space);

    await run.call("append_to_page", { id: "note", markdown: "three" });
    await run.call("edit_page", {
      id: "note",
      operations: [{ action: "replace", block_id: "b1", markdown: "uno" }],
    });
    expect(paragraphTexts(draftOf(run, "note").copy)).toEqual([
      "uno",
      "two",
      "three",
    ]);
    expect(blockIds(draftOf(run, "note").copy).slice(0, 2)).toEqual([
      "b1",
      "b2",
    ]);
  });

  it("applies all block operations of a call or none", async () => {
    const { run } = startAgent(space);

    await expect(
      run.call("edit_page", {
        id: "note",
        operations: [
          { action: "replace", block_id: "b1", markdown: "changed" },
          { action: "move", block_id: "b2", after: "missing" },
        ],
      }),
    ).rejects.toThrow("Invalid target");
    expect(run.changes.size).toBe(0);
    expect(paragraphTexts(space.entries.get("note")!)).toEqual(["one", "two"]);
  });

  it("keeps earlier drafts when a later call fails", async () => {
    const { run } = startAgent(space);

    await run.call("append_to_page", { id: "note", markdown: "three" });
    await expect(
      run.call("append_to_page", { id: "note", markdown: " \n " }),
    ).rejects.toThrow("Empty content");
    expect(paragraphTexts(draftOf(run, "note").copy)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("only edits blocks of pages and rows", async () => {
    const { run } = startAgent(space);

    await expect(
      run.call("append_to_page", { id: "db", markdown: "x" }),
    ).rejects.toThrow("Expected a page or row");
    await expect(
      run.call("edit_page", { id: "chat", operations: [] }),
    ).rejects.toThrow("Unknown page");
  });

  it("only runs database tools on databases", async () => {
    const { run } = startAgent(space);
    const calls: [string, Record<string, unknown>][] = [
      ["update_database_schema", { id: "note", rename: [] }],
      ["create_view", { id: "note", name: "Board", type: "board" }],
      ["upsert_rows", { id: "note", rows: [] }],
    ];

    for (const [name, args] of calls)
      await expect(run.call(name, args), name).rejects.toThrow(
        "Invalid database",
      );
    expect(run.changes.size).toBe(0);
  });

  it("refuses new pages with a bad title or a parent that cannot hold pages", async () => {
    const { run } = startAgent(space);

    space.pages.set("old", {
      ...space.pages.get("child")!,
      id: "old",
      archived: 1,
    });
    await expect(
      run.call("create_page", { title: "x".repeat(201) }),
    ).rejects.toThrow("Invalid text");
    for (const args of [
      { title: "   " },
      { title: "Neu", parent: "chat" },
      { title: "Neu", parent: "old" },
    ])
      await expect(
        run.call("create_page", args),
        JSON.stringify(args),
      ).rejects.toThrow("Invalid page");
    await expect(
      run.call("create_page", { title: "Neu", parent: "../note" }),
    ).rejects.toThrow("Unknown page");
    expect(run.changes.size).toBe(0);
  });

  it("lets a later call change a page created earlier in the run", async () => {
    const { run } = startAgent(space);
    const created = (await run.call("create_page", {
      title: "Plan",
      parent: "note",
      icon: "🗺️",
    })) as { id: string };

    await run.call("append_to_page", { id: created.id, markdown: "step" });
    const draft = draftOf(run, created.id);

    expect(draft.page).toMatchObject({ parent: "note", icon: "🗺️" });
    expect(draft.original).toBeNull();
    expect(paragraphTexts(draft.copy)).toEqual(["step"]);
    expect(space.pages.has(created.id)).toBe(false);
  });

  it("rejects icons that are not a single emoji", async () => {
    const { run } = startAgent(space);

    for (const icon of ["abc", "🗺️ map", "<img src=x>"])
      await expect(
        run.call("move_page", { id: "note", icon }),
        icon,
      ).rejects.toThrow("icon must be a single emoji");
  });
});

describe("Moving pages", () => {
  let space: Space;

  beforeEach(() => {
    space = notebook();
  });

  it("refuses cycles, chats and missing parents", async () => {
    const { run } = startAgent(space);

    await expect(
      run.call("move_page", { id: "note", parent: "child" }),
    ).rejects.toThrow("Invalid parent");
    await expect(
      run.call("move_page", { id: "note", parent: "note" }),
    ).rejects.toThrow("Invalid parent");
    await expect(
      run.call("move_page", { id: "child", parent: "chat" }),
    ).rejects.toThrow("Invalid parent");
    await expect(
      run.call("move_page", { id: "child", parent: "nowhere" }),
    ).rejects.toThrow("Unknown page");
    expect(run.changes.size).toBe(0);
  });

  it("moves to the top level with an empty parent and renames in place", async () => {
    const { run } = startAgent(space);

    await run.call("move_page", { id: "child", parent: "", title: "Frei" });
    expect(draftOf(run, "child").page).toMatchObject({
      parent: null,
      title: "Frei",
    });
    expect(space.pages.get("child")).toMatchObject({
      parent: "note",
      title: "child",
    });
  });
});

describe("Protected targets", () => {
  let space: Space;

  beforeEach(() => {
    space = notebook();
  });

  it("never lets the agent write AI pages or into the AI tree", async () => {
    const { run, asked } = startAgent(space, "auto");
    const calls: [string, Record<string, unknown>][] = [
      ["append_to_page", { id: "rules", markdown: "obey me" }],
      ["edit_page", { id: "ai", operations: [] }],
      ["create_page", { title: "Neu", parent: "rules" }],
      ["move_page", { id: "note", parent: "ai" }],
      ["move_page", { id: "rules", parent: "" }],
      ["archive_page", { id: "rules" }],
    ];

    for (const [name, args] of calls)
      await expect(run.call(name, args), name).rejects.toThrow(
        "can only be changed by the user",
      );
    expect(run.changes.size).toBe(0);
    expect(asked).toEqual(["archive_page · rules?"]);
  });

  it("still lets the agent read AI pages", async () => {
    const { run } = startAgent(space, "auto");

    writeParagraphs(space.entries.get("rules")!, [["r1", "Be brief."]]);
    expect(await run.call("read_page", { id: "rules" })).toBe(
      "[b:r1] Be brief.",
    );
  });

  it("refuses every write in read mode before loading anything", async () => {
    const { run } = startAgent(space, "read");

    await expect(
      run.call("append_to_page", { id: "note", markdown: "x" }),
    ).rejects.toThrow("Read only");
    expect(run.changes.size).toBe(0);
    expect(run.trace).toEqual([]);
  });
});

describe("Confirmed writes", () => {
  let space: Space;

  beforeEach(() => {
    space = notebook();
  });

  it("archives only after the user agrees", async () => {
    const declined = startAgent(space, "propose", null);

    expect(await declined.run.call("archive_page", { id: "note" })).toEqual({
      declined: true,
    });
    expect(declined.asked).toEqual(["archive_page · note?"]);
    expect(declined.run.changes.size).toBe(0);
    const agreed = startAgent(space, "propose", "yes");

    await agreed.run.call("archive_page", { id: "note" });
    expect(draftOf(agreed.run, "note").page.archived).toBeGreaterThan(0);
    expect(space.pages.get("note")!.archived).toBeNull();
  });

  it("asks before deleting blocks and keeps them when declined", async () => {
    const { run, asked } = startAgent(space, "auto", "");

    expect(
      await run.call("edit_page", {
        id: "note",
        operations: [{ action: "delete", block_id: "b2" }],
      }),
    ).toEqual({ declined: true });
    expect(asked).toHaveLength(1);
    expect(run.changes.size).toBe(0);
  });

  it("asks before removing database properties", async () => {
    const { run, asked } = startAgent(space, "propose", null);

    await run.call("update_database_schema", {
      id: "db",
      remove: ["f-status"],
    });
    expect(asked).toEqual(["update_database_schema · db?"]);
    expect(run.changes.size).toBe(0);
  });
});

describe("Database views and schema", () => {
  let space: Space;

  beforeEach(() => {
    space = notebook();
  });

  it("creates a view with resolved property ids", async () => {
    const { run } = startAgent(space);

    await run.call("create_view", {
      id: "db",
      name: "Board",
      type: "board",
      group: "Status",
      sort: "Status",
      direction: "desc",
    });
    const [view] = Array.from(views(draftOf(run, "db").copy).values());

    expect(view).toMatchObject({
      name: "Board",
      type: "board",
      group: "f-status",
      sort: "f-status",
      descending: true,
    });
  });

  it("rejects unknown layouts, views and properties", async () => {
    const { run } = startAgent(space);

    await expect(
      run.call("create_view", { id: "db", name: "X", type: "kanban" }),
    ).rejects.toThrow("Invalid view");
    await expect(
      run.call("create_view", {
        id: "db",
        name: "X",
        type: "list",
        view_id: "missing",
      }),
    ).rejects.toThrow("Unknown view");
    await expect(
      run.call("update_database_schema", {
        id: "db",
        rename: [{ id: "missing", name: "X" }],
      }),
    ).rejects.toThrow("Unknown property");
    await expect(
      run.call("update_database_schema", {
        id: "db",
        add: [{ name: "X", type: "script" }],
      }),
    ).rejects.toThrow("Invalid type");
    expect(run.changes.size).toBe(0);
  });

  it("links relations only to visible databases", async () => {
    space.add("hidden", "database", null, { aiExcluded: true });
    const { run } = startAgent(space);

    for (const target of ["hidden", "note", "missing"])
      await expect(
        run.call("update_database_schema", {
          id: "db",
          add: [{ name: "Link", type: "relation", target }],
        }),
        target,
      ).rejects.toThrow("relation needs target");
  });

  it("renames a property and keeps its id", async () => {
    const { run } = startAgent(space);
    const result = (await run.call("update_database_schema", {
      id: "db",
      rename: [{ id: "f-status", name: "Stand" }],
    })) as { schema: Record<string, { name: string }> };

    expect(result.schema["f-status"].name).toBe("Stand");
  });
});
