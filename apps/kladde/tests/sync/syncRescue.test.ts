import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Stored } from "../../src/notebook/notebook";
import type { SyncReport } from "../../src/sync/sync";

const LOCKED = "Notebook locked";
const MODIFIED = "Notebook was modified";
const REV_BYTES = 8;

const native = vi.hoisted(() => ({
  notes: new Map<string, Stored>(),
  locked: false,
  report: null as Partial<SyncReport> | null,
  removedBySync: [] as string[],
}));

function stateOf(note: Stored | undefined, after: number) {
  if (!note) return new ArrayBuffer(0);
  const fresh = note.rev > after;
  const bytes = new Uint8Array(REV_BYTES + (fresh ? note.data.length : 0));

  new DataView(bytes.buffer).setBigInt64(0, BigInt(note.rev), true);
  if (fresh) bytes.set(note.data, REV_BYTES);

  return bytes.buffer;
}

function save(notes: Stored[]) {
  if (native.locked) throw Error(LOCKED);
  for (const note of notes)
    if ((native.notes.get(note.id)?.rev ?? 0) !== note.rev)
      throw Error(MODIFIED);
  for (const note of notes)
    native.notes.set(note.id, { ...note, rev: note.rev + 1 });
}

function rowsOf(parent: unknown) {
  const rows = [...native.notes.values()].filter(
    (note) => note.kind === "row" && note.parent === parent && !note.archived,
  );

  return [rows.map((note) => [note.id, note.title, note.props]), null, 0];
}

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: Record<string, unknown>) => {
    const id = String(args.id);

    switch (name) {
      case "save":
        return save(args.notes as Stored[]);
      case "load":
        return native.notes.get(id) ?? null;
      case "load_state":
        return stateOf(native.notes.get(id), Number(args.after));
      case "rows":
        return rowsOf(args.parent);
      case "account_info":
        return ["https://sync.example.org", "test", args.space, "device"];
      case "sync_now":
        native.locked = false;
        for (const gone of native.removedBySync) native.notes.delete(gone);

        return { ...emptyReport(), ...native.report };
      case "forget":
      case "discard_rescued":
        native.notes.delete(id);

        return null;
      default:
        return null;
    }
  }),
}));

function emptyReport(): SyncReport {
  return {
    changed: [],
    removed: [],
    rescue: [],
    failed: [],
    waiting: 0,
    stopped: null,
  };
}

const { Notebook } = await import("../../src/notebook/notebook");
const { syncBook } = await import("../../src/sync/sync");

beforeEach(() => {
  native.notes = new Map();
  native.locked = false;
  native.report = null;
  native.removedBySync = [];
});

function copiesOf(book: InstanceType<typeof Notebook>, original: string) {
  return [...book.pages.values()].filter(
    (page) => page.rescued?.endsWith("/" + original) && !page.archived,
  );
}

describe("rescue after a deletion elsewhere", () => {
  it("copies database rows the page list no longer knows", async () => {
    const book = await Notebook.create("Notizbuch");
    const database = book.add("Kunden", "database");
    const rows = [
      book.add("Nord", "row", database.id),
      book.add("Süd", "row", database.id),
    ];

    await book.flush();
    book.pages.deleteAll(rows.map((row) => row.id));
    for (const row of rows) book.release(row.id);
    await book.flush();
    native.report = { rescue: [database.id] };
    const result = await syncBook(book);
    const [copy] = copiesOf(book, database.id);
    const copied = [...book.pages.values()]
      .filter((page) => page.parent === copy?.id && page.kind === "row")
      .map((page) => page.title)
      .sort();

    expect(result.recovered).toEqual(["Kunden"]);
    expect(copied).toEqual(["Nord", "Süd"]);
    expect(book.pages.has(database.id)).toBe(false);
  });

  it("keeps an unsaved draft of a removed page as a rescued copy", async () => {
    const book = await Notebook.create("Notizbuch");
    const draft = book.add("Entwurf");

    await book.flush();
    native.locked = true;
    draft.doc.getMap("meta").set("text", "neue Fassung");
    await expect(book.flush()).rejects.toThrow(LOCKED);
    native.report = { removed: [draft.id] };
    native.removedBySync = [draft.id];
    const result = await syncBook(book);
    const [copy] = copiesOf(book, draft.id);

    expect(result.recovered).toEqual(["Entwurf"]);
    expect(copy?.title).toBe("Entwurf");
    const stored = native.notes.get(copy!.id);

    expect(stored?.body).toBe("neue Fassung");
    expect(book.pages.has(draft.id)).toBe(false);
  });

  it("drops a removed page without unsaved changes", async () => {
    const book = await Notebook.create("Notizbuch");
    const page = book.add("erledigt");

    await book.flush();
    native.report = { removed: [page.id] };
    native.removedBySync = [page.id];
    const result = await syncBook(book);

    expect(result.recovered).toEqual([]);
    expect(book.entries.has(page.id)).toBe(false);
    expect(copiesOf(book, page.id)).toEqual([]);
  });
});
