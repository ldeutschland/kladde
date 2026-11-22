import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
}));

vi.mock("../../src/platform/native", () => ({
  fileBase64: async (blob: Blob) =>
    Buffer.from(await blob.arrayBuffer()).toString("base64"),
  command: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "load_state") return new ArrayBuffer(0);

    if (name === "add_file") {
      const id = crypto.randomUUID();

      native.files.set(id, Buffer.from(String(args.data), "base64"));

      return id;
    }

    if (name === "read_file") {
      const bytes = native.files.get(String(args.id));

      if (!bytes) throw Error("Download denied");

      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    }

    return undefined;
  }),
}));

const { Notebook } = await import("../../src/notebook/notebook");
const { FILE_PART_BYTES, copyFile, fileBlob, fileMeta, saveFile } =
  await import("../../src/files/attachments");

function patterned(size: number) {
  const bytes = new Uint8Array(size);

  for (let index = 0; index < size; index += 4099) bytes[index] = index % 251;
  bytes[size - 1] = 7;

  return bytes;
}

async function bytesOf(blob: Blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

beforeEach(() => native.files.clear());

describe("attachments", () => {
  it("stores a small file as a single part under its own id", async () => {
    const book = await Notebook.create("Notizbuch");
    const page = book.add("Seite");
    const url = await saveFile(book, page, new File(["hallo"], "a.txt"));
    const id = url.slice("kladde-file:".length);

    expect(native.files.has(id)).toBe(true);
    expect(fileMeta(page, id)).toEqual({
      type: "",
      name: "a.txt",
      size: 5,
      parts: undefined,
    });
    expect(await (await fileBlob(book, page, id)).text()).toBe("hallo");
  });

  it("splits a large file into parts and joins them again", async () => {
    const book = await Notebook.create("Notizbuch");
    const page = book.add("Seite");
    const content = patterned(FILE_PART_BYTES * 2 + 5);
    const file = new File([content], "aufnahme.m4a", { type: "audio/mp4" });
    const id = (await saveFile(book, page, file)).slice(12);
    const meta = fileMeta(page, id);

    expect(meta?.size).toBe(content.length);
    expect(meta?.parts).toHaveLength(3);
    expect(native.files.has(id)).toBe(false);
    const sizes = meta!.parts!.map((part) => native.files.get(part)!.length);

    expect(sizes).toEqual([FILE_PART_BYTES, FILE_PART_BYTES, 5]);
    const joined = await bytesOf(await fileBlob(book, page, id, "audio/mp4"));

    expect(joined.length).toBe(content.length);
    expect(Buffer.from(joined).equals(Buffer.from(content))).toBe(true);
  });

  it("copies every part of a file into another page", async () => {
    const book = await Notebook.create("Notizbuch");
    const [from, to] = [book.add("Quelle"), book.add("Ziel")];
    const content = patterned(FILE_PART_BYTES + 9);
    const id = (
      await saveFile(book, from, new File([content], "film.mp4"))
    ).slice(12);
    const copied = await copyFile(book, from, book, to, id);
    const meta = fileMeta(to, copied!);

    expect(copied).not.toBe(id);
    expect(meta?.name).toBe("film.mp4");
    expect(meta?.parts).toHaveLength(2);
    expect(
      meta!.parts!.some((part) => fileMeta(from, id)!.parts!.includes(part)),
    ).toBe(false);
    const joined = await bytesOf(await fileBlob(book, to, copied!));

    expect(Buffer.from(joined).equals(Buffer.from(content))).toBe(true);
  });

  it("rejects a malformed list of parts", async () => {
    const book = await Notebook.create("Notizbuch");
    const page = book.add("Seite");
    const files = page.doc.getMap("files");
    const part = crypto.randomUUID();
    const cases = [[], ["nope"], [part, part], [7], "text"];

    for (const parts of cases) {
      const id = crypto.randomUUID();

      files.set(id, { type: "", name: "x", size: 1, parts });
      expect(() => fileMeta(page, id)).toThrow("Invalid file");
    }
  });
});
