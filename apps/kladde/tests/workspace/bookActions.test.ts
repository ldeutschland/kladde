import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Notebook as Book } from "../../src/notebook/notebook";
import type { T } from "../../src/locale/locale";

interface SavedNote {
  id: string;
  space: string;
  kind: string;
  title: string;
  rev: number;
}

const native = vi.hoisted(() => ({
  calls: [] as string[],
  saved: [] as SavedNote[],
  manifests: new Map<string, ArrayBuffer>(),
  failing: new Set<string>(),
}));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: Record<string, unknown>) => {
    native.calls.push(args.space ? name + " " + args.space : name);
    if (native.failing.has(name)) throw Error(name + " failed");
    if (name === "load_manifest") return native.manifests.get(String(args.id));
    if (name === "save") native.saved.push(...(args.notes as SavedNote[]));

    return undefined;
  }),
}));

const { Notebook } = await import("../../src/notebook/notebook");
const { cleanBookName, deleteBook, deletionProblem, renameBook } =
  await import("../../src/workspace/bookActions");

const REV_BYTES = 8;
const OTHER = "other-notebook";
const t = ((key: string) =>
  key === "deleteBookFailed" ? "„{name}“ wurde nicht gelöscht." : key) as T;

function manifestState(title: string, rev: number) {
  const doc = new Y.Doc();

  doc.getMap("meta").set("title", title);
  const update = Y.encodeStateAsUpdate(doc);
  const bytes = new Uint8Array(REV_BYTES + update.length);

  new DataView(bytes.buffer).setBigInt64(0, BigInt(rev), true);
  bytes.set(update, REV_BYTES);

  return bytes.buffer;
}

async function openBook(title: string) {
  const book = await Notebook.create(title);

  native.calls = [];
  native.saved = [];

  return book;
}

function openFake(id: string) {
  const flush = vi.fn(async () => {
    native.calls.push("flush");
  });

  return { id, flush } as unknown as Book;
}

beforeEach(() => {
  native.calls = [];
  native.saved = [];
  native.manifests = new Map();
  native.failing = new Set();
});

describe("notebook names", () => {
  it("trims names and turns control characters into spaces", () => {
    expect(cleanBookName("  Arbeit\tNotizen \n")).toBe("Arbeit Notizen");
    expect(cleanBookName("Ar\u0000beit")).toBe("Ar beit");
  });

  it("keeps two hundred characters without splitting an emoji", () => {
    expect(cleanBookName("📚".repeat(250))).toBe("📚".repeat(200));
  });

  it("leaves nothing of a blank name", () => {
    expect(cleanBookName(" \t\n ")).toBe("");
  });
});

describe("renaming", () => {
  it("renames the open notebook in place", async () => {
    const book = await openBook("Mein Notizbuch");

    expect(await renameBook(book, book.id, "  Projekte ")).toBe(true);
    expect(book.title).toBe("Projekte");
    expect(native.calls).toEqual(["save"]);
    expect(native.saved).toMatchObject([
      { id: book.id, kind: "workspace", title: "Projekte" },
    ]);
  });

  it("renames another notebook from its manifest alone", async () => {
    const book = await openBook("Offen");

    native.manifests.set(OTHER, manifestState("Alt", 3));
    expect(await renameBook(book, OTHER, "Neu")).toBe(true);
    expect(native.calls).toEqual(["load_manifest", "save"]);
    expect(native.saved).toMatchObject([
      { id: OTHER, space: OTHER, kind: "workspace", title: "Neu", rev: 3 },
    ]);
    expect(book.title).toBe("Offen");
  });

  it("leaves a blank or unchanged name alone", async () => {
    const book = await openBook("Offen");

    expect(await renameBook(book, book.id, "   ")).toBe(false);
    expect(await renameBook(book, book.id, " Offen ")).toBe(false);
    expect(native.calls).toEqual([]);
  });
});

describe("deleting", () => {
  it("saves the open notebook before deleting it", async () => {
    const open = openFake("open-notebook");

    await deleteBook(open, {
      id: open.id,
      fromServer: false,
      syncsHere: false,
    });
    expect(native.calls).toEqual(["flush", "delete_space open-notebook"]);
  });

  it("removes a notebook from the server before deleting it here", async () => {
    await deleteBook(openFake("open-notebook"), {
      id: OTHER,
      fromServer: true,
      syncsHere: true,
    });
    expect(native.calls).toEqual([
      "remove_space " + OTHER,
      "delete_space " + OTHER,
    ]);
  });

  it("syncs a notebook that stays on the server before deleting it here", async () => {
    const removal = { id: OTHER, fromServer: false, syncsHere: true };
    const expected = ["sync_now " + OTHER, "delete_space " + OTHER];

    await deleteBook(openFake("open-notebook"), removal);
    expect(native.calls).toEqual(expected);
    native.calls = [];
    native.failing.add("sync_now");
    await deleteBook(openFake("open-notebook"), removal);
    expect(native.calls).toEqual(expected);
  });

  it("deletes nothing here when the server keeps the notebook", async () => {
    native.failing.add("remove_space");
    await expect(
      deleteBook(openFake("open-notebook"), {
        id: OTHER,
        fromServer: true,
        syncsHere: true,
      }),
    ).rejects.toThrow("remove_space failed");
    expect(native.calls).toEqual(["remove_space " + OTHER]);
  });
});

describe("deletion problems", () => {
  it("explains why the backend refused to delete", () => {
    const unsynced = Error("Notebook has unsynced changes");
    const last = "Error: The last notebook on this device stays";

    expect(deletionProblem(unsynced, "Arbeit", t)).toBe("deleteBookUnsynced");
    expect(deletionProblem(last, "Arbeit", t)).toBe("deleteBookLast");
  });

  it("names the notebook for any other failure", () => {
    expect(deletionProblem(Error("Disk full"), "Arbeit", t)).toBe(
      "„Arbeit“ wurde nicht gelöscht. Error: Disk full",
    );
  });
});
