import { beforeEach, describe, expect, it, vi } from "vitest";
import type { T } from "../../src/locale/locale";
import type { Entry, Notebook } from "../../src/notebook/notebook";
import type { RecorderControls } from "../../src/capture/types";

const written = vi.hoisted(() => ({ blocks: [] as unknown[][] }));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async () => undefined),
}));
vi.mock("@blocknote/core/yjs", async (original) => ({
  ...(await original<typeof import("@blocknote/core/yjs")>()),
  blocksToYXmlFragment: (_editor: unknown, blocks: unknown[]) =>
    void written.blocks.push(blocks),
}));
vi.mock("../../src/notebook/content", async (original) => ({
  ...(await original<typeof import("../../src/notebook/content")>()),
  blockEditor: () => ({
    tryParseMarkdownToBlocks: (text: string) =>
      text ? [{ type: "paragraph", content: text }] : [],
  }),
  writeMarkdown: (entry: Entry, text: string) =>
    entry.doc.getMap("meta").set("text", text),
  markdown: (entry: Entry) => `md:${entry.doc.getMap("meta").get("text")}`,
}));

const { Notebook: Book } = await import("../../src/notebook/notebook");
const { saveNote } = await import("../../src/capture/saveNote");
const { destination, QUICK_NOTES } =
  await import("../../src/capture/destinations");

const TITLE_LENGTH = 200;
const VOICE_URL = "kladde-file:00000000-0000-4000-8000-000000000000";
const t = ((key: string) => key) as T;

function recorder() {
  const save = vi.fn(async () => VOICE_URL);

  return { save, controls: { save } as unknown as RecorderControls };
}

function note(target: Notebook, key: string, text: string, spoken = null) {
  return {
    target,
    key,
    draft: { text, spoken } as { text: string; spoken: number | null },
    file: undefined,
    recorder: recorder().controls,
    t,
    lang: "de",
  };
}

async function captured(book: Notebook, key: string) {
  const entry = await book.load(key);

  return { entry, meta: entry.doc.getMap("meta") };
}

beforeEach(() => {
  written.blocks = [];
});

describe("saving a quick note", () => {
  it("files a new note as a row of the quick notes database titled by its first line", async () => {
    const book = await Book.create("Notizbuch");

    await saveNote(note(book, "n1", "  Einkauf\n- Milch\n- Brot  "));
    const page = book.pages.get("n1")!;
    const { meta } = await captured(book, "n1");

    expect(page.kind).toBe("row");
    expect(page.parent).toBe(destination(book, QUICK_NOTES));
    expect(page.title).toBe("Einkauf");
    expect(meta.get("captureId")).toBe("n1");
    expect(meta.get("captured")).toBe(true);
    expect(meta.get("text")).toBe("Einkauf\n- Milch\n- Brot");
  });

  it("caps the title length", async () => {
    const book = await Book.create("Notizbuch");

    await saveNote(note(book, "n2", "x".repeat(TITLE_LENGTH + 50)));
    expect(book.pages.get("n2")!.title).toHaveLength(TITLE_LENGTH);
  });

  it("does not write the content twice when the same capture is saved again", async () => {
    const book = await Book.create("Notizbuch");

    await saveNote(note(book, "n3", "erste Fassung"));
    await saveNote(note(book, "n3", "zweite Fassung"));
    const { meta } = await captured(book, "n3");

    expect(meta.get("text")).toBe("erste Fassung");
    expect(
      Array.from(book.pages.values()).filter((p) => p.kind === "row"),
    ).toHaveLength(1);
  });

  it("refuses to write into an existing page that is not this capture", async () => {
    const book = await Book.create("Notizbuch");
    const other = book.add("Tagebuch");

    other.doc.getMap("meta").set("text", "privat");
    await expect(
      saveNote(note(book, other.id, "überschrieben")),
    ).rejects.toThrow("pageUnavailable");
    expect(other.doc.getMap("meta").get("text")).toBe("privat");
    expect(other.doc.getMap("meta").get("captureId")).toBeUndefined();
  });

  it("refuses to write into a trashed page", async () => {
    const book = await Book.create("Notizbuch");

    await saveNote(note(book, "n4", "Notiz"));
    await book.change("n4", { archived: 1 });
    await expect(saveNote(note(book, "n4", "neu"))).rejects.toThrow(
      "pageUnavailable",
    );
  });

  it("titles a voice note after the recording and appends the audio once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 22, 9, 5));
    const book = await Book.create("Notizbuch");
    const voice = recorder();

    await saveNote({
      ...note(book, "n5", "Gesagt"),
      draft: { text: "", spoken: 12 },
      recorder: voice.controls,
    });
    vi.useRealTimers();
    const name = "voiceNote 22.11.2026, 09-05.m4a";
    const { entry } = await captured(book, "n5");

    expect(book.pages.get("n5")!.title).toBe(name);
    expect(voice.save).toHaveBeenCalledWith(book, entry, name);
    expect(written.blocks).toEqual([
      [{ type: "audio", props: { name, url: VOICE_URL } }],
    ]);
    expect(entry.doc.getMap("meta").get("text")).toBe("md:");
  });
});
