import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestSpace } from "../support/agentFixture";

const native = vi.hoisted(() => ({
  hits: [] as { doc: string }[],
  backlinks: [] as string[],
  scopes: [] as unknown[],
}));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: { parent?: string }) => {
    if (name === "search_content") {
      native.scopes.push(args.parent);

      return {
        hits: native.hits.map((hit) => ({
          file: null,
          name: "",
          snippet: "",
          offset: 0,
          ...hit,
        })),
        pending: 0,
      };
    }

    if (name === "backlinks") return native.backlinks;
    throw Error("Unexpected native command " + name);
  }),
}));
vi.mock("../../src/notebook/content", async (importOriginal) =>
  (await import("../support/plainContent")).plainContent(
    await importOriginal(),
  ),
);

const { AgentRun } = await import("../../src/ai/AgentRun");
const { startAgent, testSpace, writeParagraphs } =
  await import("../support/agentFixture");

type Run = ReturnType<typeof startAgent>["run"];

function notebook() {
  const space = testSpace();

  space.add("home", "page", null);
  space.add("plans", "page", "home");
  space.add("trip", "page", "plans");
  space.add("secret", "page", null, { aiExcluded: true });
  space.add("old", "page", null, { archived: 1 });
  space.add("talk", "chat", null);

  return space;
}

function ids(found: unknown) {
  return (found as { id: string }[]).map((entry) => entry.id);
}

describe("Reading pages", () => {
  let space: TestSpace;

  beforeEach(() => {
    space = notebook();
  });

  it("returns blocks with their ids, forty at a time", async () => {
    const { run } = startAgent(space, "read");

    writeParagraphs(
      space.entries.get("home")!,
      Array.from({ length: 45 }, (_, index) => ["b" + index, "Zeile " + index]),
    );
    const first = (await run.call("read_page", { id: "home" })) as string;
    const rest = (await run.call("read_page", {
      id: "home",
      offset: 40,
    })) as string;

    expect(first.split("\n")).toHaveLength(40);
    expect(first.split("\n")[0]).toBe("[b:b0] Zeile 0");
    expect(rest.split("\n")).toEqual([
      "[b:b40] Zeile 40",
      "[b:b41] Zeile 41",
      "[b:b42] Zeile 42",
      "[b:b43] Zeile 43",
      "[b:b44] Zeile 44",
    ]);
    expect(run.shared.has("home")).toBe(true);
  });

  it("refuses archived pages and chats", async () => {
    const { run } = startAgent(space, "read");

    for (const id of ["old", "talk"])
      await expect(run.call("read_page", { id }), id).rejects.toThrow(
        "Unknown page",
      );
  });
});

describe("Citations", () => {
  let space: TestSpace;
  let run: Run;

  beforeEach(() => {
    space = notebook();
    writeParagraphs(space.entries.get("trip")!, [
      ["t1", "Abflug am 3. Mai"],
      ["t2", "Hotel am Hafen"],
    ]);
    run = startAgent(space, "read").run;
  });

  it("numbers verbatim quotes and records where they were found", async () => {
    expect(
      await run.call("cite", { id: "trip", quote: " Hotel am Hafen " }),
    ).toEqual({ quote: "Hotel am Hafen", link: "source:1", title: "trip" });
    expect(
      await run.call("cite", { id: "trip", quote: "3. Mai" }),
    ).toMatchObject({ link: "source:2" });
    expect(run.citations[0]).toMatchObject({
      doc: "trip",
      file: null,
      offset: "Abflug am 3. Mai\n\n".length,
    });
  });

  it("refuses quotes that are not in the source", async () => {
    await expect(
      run.call("cite", { id: "trip", quote: "Hotel am Strand" }),
    ).rejects.toThrow("Quote not found in source");
    expect(run.citations).toEqual([]);
  });

  it("refuses empty, oversized and control-character quotes", async () => {
    for (const quote of ["   ", "Ho\0tel", "Ho\ftel"])
      await expect(
        run.call("cite", { id: "trip", quote }),
        JSON.stringify(quote),
      ).rejects.toThrow("Invalid quote");
    await expect(
      run.call("cite", { id: "trip", quote: "x".repeat(321) }),
    ).rejects.toThrow("Invalid text");
  });

  it("stops after thirty-two citations", async () => {
    const counted = new AgentRun(space.book, null, "read", async () => "", 100);

    for (let index = 0; index < 32; index++)
      await counted.call("cite", { id: "trip", quote: "Hotel" });
    await expect(
      counted.call("cite", { id: "trip", quote: "Hotel" }),
    ).rejects.toThrow("Source unavailable");
  });
});

describe("Listing and searching", () => {
  let space: TestSpace;

  beforeEach(() => {
    space = notebook();
    native.hits = [];
    native.backlinks = [];
    native.scopes = [];
  });

  it("lists top-level pages, deeper levels on request and direct children", async () => {
    const { run } = startAgent(space, "read");

    expect(ids(await run.call("workspace_tree", {}))).toEqual(["home"]);
    expect(ids(await run.call("workspace_tree", { depth: 1 }))).toEqual([
      "home",
      "plans",
    ]);
    expect(ids(await run.call("workspace_tree", { depth: 999 }))).toEqual([
      "home",
      "plans",
      "trip",
    ]);
    expect(ids(await run.call("workspace_tree", { parent: "plans" }))).toEqual([
      "trip",
    ]);
  });

  it("pages through large trees fifty entries at a time", async () => {
    for (let index = 0; index < 60; index++)
      space.add("p" + index, "page", null);
    const { run } = startAgent(space, "read");
    const first = ids(await run.call("workspace_tree", {}));
    const second = ids(await run.call("workspace_tree", { offset: 50 }));

    expect(first).toHaveLength(50);
    expect(second).toHaveLength(11);
    expect(new Set([...first, ...second]).size).toBe(61);
  });

  it("drops search hits on hidden, archived, unknown and out-of-scope pages", async () => {
    const { run } = startAgent(space, "read");

    native.hits = ["secret", "old", "talk", "ghost", "trip", "home"].map(
      (doc) => ({ doc }),
    );
    const found = (await run.call("search", {
      query: "x",
      parent: "plans",
    })) as { matches: { id: string }[] };

    expect(ids(found.matches)).toEqual(["trip"]);
    expect(native.scopes).toEqual(["plans"]);
    expect(run.shared.has("secret")).toBe(false);
  });

  it("never shows the AI the title of an excluded page a hit links to", async () => {
    const hidden = "7d1c3b2a-9e8f-4a6b-8c5d-1e2f3a4b5c6d";
    const home = space.entries.get("home")!;

    space.add(hidden, "page", null, { aiExcluded: true });
    writeParagraphs(home, [["b1", "Siehe Plan"]]);
    home.doc
      .getMap("meta")
      .set("text", `Siehe [Gehaltsrunde](kladde:${hidden}) Plan`);
    native.hits = [
      { doc: "home", snippet: "Siehe Gehaltsrunde Plan" } as never,
    ];
    const { run } = startAgent(space, "read");
    const guessed = (await run.call("search", { query: "Gehaltsrunde" })) as {
      matches: { id: string }[];
    };
    const matched = (await run.call("search", { query: "siehe" })) as {
      matches: { id: string; snippet: string }[];
    };

    expect(guessed.matches).toEqual([]);
    expect(matched.matches).toEqual([
      expect.objectContaining({ id: "home", snippet: "" }),
    ]);
  });

  it("adds title matches the full-text index missed", async () => {
    const { run } = startAgent(space, "read");
    const found = (await run.call("search", { query: "PLAN" })) as {
      matches: { id: string }[];
    };

    expect(ids(found.matches)).toEqual(["plans"]);
  });

  it("requires a short, non-empty query", async () => {
    const { run } = startAgent(space, "read");

    await expect(run.call("search", { query: "  " })).rejects.toThrow(
      "Enter search terms",
    );
    await expect(
      run.call("search", { query: "x".repeat(257) }),
    ).rejects.toThrow("Invalid text");
  });

  it("lists only visible backlinks", async () => {
    const { run } = startAgent(space, "read");

    native.backlinks = ["secret", "old", "talk", "ghost", "plans"];
    expect(await run.call("backlinks", { id: "trip" })).toEqual([
      { id: "plans", title: "plans" },
    ]);
  });
});
