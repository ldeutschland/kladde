import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { AgentRun } from "../../src/ai/AgentRun";
import {
  aiExcluded,
  exclusionChecker,
  exclusionSource,
  rolePages,
  sharingChecker,
} from "../../src/ai/aiPages";
import { type Field, type Row } from "../../src/database/types";
import {
  freshPage,
  type Entry,
  type Kind,
  type Notebook,
  type Page,
} from "../../src/notebook/notebook";
import { sharedRows } from "../../src/database/sharedRows";

function listing(entries: [string, string | null, Partial<Page>?][]) {
  const pages = new Map<string, Page>();

  for (const [id, parent, patch] of entries)
    pages.set(id, { ...freshPage(id, id, "page", parent), ...patch });

  return pages;
}

function bookWith(pages: Map<string, Page>) {
  const settings = new Y.Doc().getMap<unknown>("settings");

  return {
    id: "space",
    pages,
    settings,
    editedAt: () => 0,
    load: async () => {
      throw Error("Document unavailable");
    },
  } as unknown as Notebook;
}

const database: Kind = "database";
const row: Kind = "row";

function familyTree() {
  return listing([
    ["open", null],
    ["secret", null, { aiExcluded: true }],
    ["child", "secret"],
    ["grandchild", "child"],
    ["db", "child", { kind: database }],
    ["row", "db", { kind: row }],
  ]);
}

describe("AI exclusion", () => {
  it("covers the page and everything below it", () => {
    const book = bookWith(familyTree());

    for (const id of ["secret", "child", "grandchild", "db", "row"])
      expect(aiExcluded(book, id)).toBe(true);
    for (const id of ["open", "missing", "", null, 7])
      expect(aiExcluded(book, id)).toBe(false);
    expect(exclusionSource(book.pages, "row")?.id).toBe("secret");
    expect(exclusionSource(book.pages, "open")).toBeUndefined();
  });

  it("is inherited from a parent in the trash", () => {
    const pages = listing([
      ["trashed", null, { aiExcluded: true, archived: 5 }],
      ["orphan", "trashed"],
    ]);

    expect(aiExcluded(bookWith(pages), "orphan")).toBe(true);
  });

  it("ends on parent cycles and still finds a marked member", () => {
    const loop = listing([
      ["a", "b"],
      ["b", "a"],
    ]);

    expect(aiExcluded(bookWith(loop), "a")).toBe(false);
    const marked = listing([
      ["a", "b"],
      ["b", "c"],
      ["c", "a", { aiExcluded: true }],
    ]);

    for (const id of ["a", "b", "c"])
      expect(aiExcluded(bookWith(marked), id)).toBe(true);
  });

  it("gives the same answers when one checker is reused", () => {
    const pages = familyTree();
    const book = bookWith(pages);
    const excluded = exclusionChecker(pages);
    const ids = [...pages.keys(), "missing", "row", "open", "grandchild"];

    for (const id of ids) expect(excluded(id)).toBe(aiExcluded(book, id));
    expect(excluded(undefined)).toBe(false);
  });

  it("keeps excluded pages out of instructions, templates and memories", () => {
    const pages = listing([
      ["secret", null, { aiExcluded: true }],
      ["hidden rule", "secret", { ai: "instructions" }],
      ["rule", null, { ai: "instructions" }],
    ]);
    const used = rolePages(bookWith(pages), "instructions");

    expect(used.map((page) => page.id)).toEqual(["rule"]);
  });
});

describe("Rows shared with AI", () => {
  const field = (id: string, type: Field["type"]) =>
    ({ id, name: id, type, options: [] }) as Field;
  const schema = [field("customer", "relation"), field("note", "text")];
  const hidden = (id: string) => id.startsWith("hidden");
  const rowOf = (id: string, values: Record<string, string>): Row => ({
    id,
    title: id,
    values,
  });

  it("drops excluded rows and links to them", () => {
    const untouched = rowOf("a", { customer: "c1", note: "hidden-word" });
    const rows = [
      untouched,
      rowOf("b", { customer: "hidden-1,c2,hidden-2", note: "x" }),
      rowOf("hidden-row", { customer: "c1" }),
    ];
    const shared = sharedRows(rows, schema, hidden);

    expect(shared.map((r) => r.id)).toEqual(["a", "b"]);
    expect(shared[0]).toBe(untouched);
    expect(shared[1].values).toEqual({ customer: "c2", note: "x" });
    expect(rows[1].values.customer).toBe("hidden-1,c2,hidden-2");
  });

  it("leaves out rows and pages whose index entry is missing", () => {
    const pages = listing([
      ["open", null],
      ["db", "open", { kind: database }],
      ["listed", "db", { kind: row }],
      ["stray", "lost parent"],
    ]);
    const unknownHidden = sharingChecker(pages);
    const rows = [
      rowOf("listed", { customer: "unindexed,open" }),
      rowOf("unindexed", { note: "secret" }),
    ];
    const shared = sharedRows(rows, schema, unknownHidden);

    expect(shared.map((r) => r.id)).toEqual(["listed"]);
    expect(shared[0].values.customer).toBe("open");
    expect(unknownHidden("stray")).toBe(true);
    expect(unknownHidden("open")).toBe(false);
    expect(unknownHidden("")).toBe(false);
    expect(exclusionChecker(pages)("unindexed")).toBe(false);
  });
});

describe("Agent tools and excluded pages", () => {
  function agent(mode = "propose") {
    const pages = familyTree();
    const book = bookWith(pages);
    const asked: string[] = [];
    const ask = async (question: string) => {
      asked.push(question);

      return "yes";
    };
    const current = { id: "secret" } as Entry;

    return { run: new AgentRun(book, current, mode, ask, 60), pages, asked };
  }

  it("lists neither excluded pages nor the open excluded page", async () => {
    const { run } = agent();
    const tree = (await run.call("workspace_tree", { depth: 8 })) as Page[];

    expect(tree.map((page) => page.id)).toEqual(["open"]);
    expect(await run.call("get_context", {})).toEqual({
      open_page: null,
      attached: [],
    });
    expect(await run.attach(["secret", "child", "row"])).toEqual([]);
  });

  it("answers every reference to an excluded page like an unknown one", async () => {
    const { run, asked } = agent("auto");
    const calls: [string, Record<string, unknown>][] = [
      ["read_page", { id: "secret" }],
      ["read_page", { id: "row" }],
      ["cite", { id: "child", quote: "x" }],
      ["backlinks", { id: "grandchild" }],
      ["list_attachments", { id: "child" }],
      ["inspect_database", { id: "db" }],
      ["query_database", { id: "db" }],
      ["workspace_tree", { parent: "secret" }],
      ["search", { query: "x", parent: "child" }],
      ["search", { query: "x", database: "db" }],
      ["append_to_page", { id: "child", markdown: "x" }],
      ["edit_page", { id: "secret", operations: [] }],
      ["archive_page", { id: "secret" }],
      ["create_page", { title: "Neu", parent: "grandchild" }],
      ["create_database", { title: "Neu", properties: [], parent: "secret" }],
      ["move_page", { id: "open", parent: "child" }],
      ["upsert_rows", { id: "db", rows: [{ title: "x" }] }],
      ["upsert_rows", { id: "open", rows: [{ id: "row" }] }],
    ];

    for (const [name, args] of calls)
      await expect(run.call(name, args), name).rejects.toThrow("Unknown page");
    expect(asked).toEqual([]);
    expect(run.changes.size).toBe(0);
  });

  it("treats pages and rows missing from the index as unknown", async () => {
    const { run, pages } = agent("auto");

    pages.set("orphan", freshPage("orphan", "orphan", "page", "unloaded"));
    expect(run.excluded("unindexed row")).toBe(true);
    expect(run.excluded("orphan")).toBe(true);
    expect(run.excluded("open")).toBe(false);
    expect(run.excluded(undefined)).toBe(false);
    for (const id of ["unindexed row", "orphan"])
      await expect(run.call("read_page", { id })).rejects.toThrow(
        "Unknown page",
      );
  });

  it("loses drafts below a page that is excluded during the run", async () => {
    const { run, pages } = agent();
    const draft = (await run.call("create_page", {
      title: "Entwurf",
      parent: "open",
    })) as { id: string };

    expect(run.page(draft.id)?.title).toBe("Entwurf");
    pages.set("open", { ...pages.get("open")!, aiExcluded: true });
    expect(run.page(draft.id)).toBeUndefined();
    await expect(run.call("read_page", { id: draft.id })).rejects.toThrow(
      "Unknown page",
    );
  });
});
