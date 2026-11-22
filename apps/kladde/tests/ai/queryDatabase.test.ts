import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestSpace } from "../support/agentFixture";

const native = vi.hoisted(() => ({
  rows: new Map<string, [string, string, string][]>(),
  asked: [] as string[],
}));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: { parent: string }) => {
    native.asked.push(name);
    if (name === "rows") return [native.rows.get(args.parent) ?? [], null, 0];
    if (name === "rows_changed") return [[], null, 0];
    throw Error("Unexpected native command " + name);
  }),
}));
vi.mock("../../src/notebook/content", async (importOriginal) =>
  (await import("../support/plainContent")).plainContent(
    await importOriginal(),
  ),
);

const { addField, startAgent, testSpace } =
  await import("../support/agentFixture");

interface Found {
  id: string;
  title: string;
  values: Record<string, string>;
}

function notebook() {
  const space = testSpace();
  const db = space.add("db", "database", null);

  addField(db, {
    id: "f-status",
    name: "Status",
    type: "status",
    options: ["Open", "Done"],
  });
  addField(db, { id: "f-score", name: "Score", type: "number", options: [] });
  addField(db, {
    id: "f-link",
    name: "Link",
    type: "relation",
    options: [],
    target: "other",
  });
  space.add("other", "database", null);
  for (const [id, parent, aiExcluded] of [
    ["r1", "db", false],
    ["r2", "db", false],
    ["r3", "db", true],
    ["o1", "other", false],
    ["o2", "other", true],
  ] as const)
    space.add(id, "row", parent, { aiExcluded });
  native.rows.set("db", [
    ["r1", "Erster", '{"f-status":"Open","f-score":"5","f-link":"o1,o2"}'],
    ["r2", "Zweiter", '{"f-status":"Done","f-score":"7"}'],
    ["r3", "Geheim", '{"f-status":"Open","f-score":"9"}'],
  ]);
  native.rows.set("other", [
    ["o1", "Offen", "{}"],
    ["o2", "Versteckt", "{}"],
  ]);

  return space;
}

async function query(
  run: ReturnType<typeof startAgent>["run"],
  args: Record<string, unknown>,
) {
  return (await run.call("query_database", { id: "db", ...args })) as Found[];
}

describe("Querying databases", () => {
  let space: TestSpace;

  beforeEach(() => {
    native.asked = [];
    space = notebook();
  });

  it("leaves out excluded rows and links to them", async () => {
    const { run } = startAgent(space, "read");
    const rows = await query(run, {});

    expect(rows.map((row) => row.id).sort()).toEqual(["r1", "r2"]);
    expect(rows.find((row) => row.id === "r1")!.values["f-link"]).toBe("o1");
    expect([...run.shared].sort()).toEqual(["r1", "r2"]);
  });

  it("filters, sorts and pages through rows", async () => {
    const { run } = startAgent(space, "read");

    expect(
      (
        await query(run, {
          filters: [{ field: "Status", op: "equals", value: "Open" }],
        })
      ).map((row) => row.id),
    ).toEqual(["r1"]);
    expect(
      (await query(run, { sort: "Score", direction: "desc" })).map(
        (row) => row.id,
      ),
    ).toEqual(["r2", "r1"]);
    expect(
      (
        await query(run, {
          sort: "Score",
          direction: "desc",
          offset: 1,
          limit: 1,
        })
      ).map((row) => row.id),
    ).toEqual(["r1"]);
  });

  it("returns at most one hundred rows however large the limit", async () => {
    native.rows.set(
      "db",
      Array.from({ length: 120 }, (_, index) => {
        space.add("n" + index, "row", "db");

        return ["n" + index, "Zeile " + index, "{}"] as [
          string,
          string,
          string,
        ];
      }),
    );
    const { run } = startAgent(space, "read");

    expect(await query(run, { limit: 100000 })).toHaveLength(100);
  });

  it("sees drafts of this run, including archived rows", async () => {
    const { run } = startAgent(space, "propose");
    const created = (await run.call("upsert_rows", {
      id: "db",
      rows: [{ title: "Entwurf", values: { Score: "1" } }],
    })) as { rows: string[] };

    await run.call("archive_page", { id: "r2" });
    const rows = await query(run, {});

    expect(rows.map((row) => row.id).sort()).toEqual(
      [created.rows[0], "r1"].sort(),
    );
  });

  it("checks filters before reading any rows", async () => {
    const { run } = startAgent(space, "read");

    await expect(
      query(run, { filters: [{ field: "Score", op: "contains" }] }),
    ).rejects.toThrow("Invalid operator");
    await expect(query(run, { sort: "Secret" })).rejects.toThrow(
      "Unknown property",
    );
    expect(native.asked).toEqual([]);
  });

  it("only queries visible databases", async () => {
    const { run } = startAgent(space, "read");

    space.add("page", "page", null);
    space.add("hidden", "database", null, { aiExcluded: true });
    await expect(run.call("query_database", { id: "page" })).rejects.toThrow(
      "Invalid database",
    );
    await expect(run.call("query_database", { id: "hidden" })).rejects.toThrow(
      "Unknown page",
    );
  });
});
