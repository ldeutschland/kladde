import { describe, expect, it } from "vitest";
import { strToU8, zipSync, type Zippable } from "fflate";
import {
  asFile,
  exportFiles,
  isZip,
  mimeType,
  readSources,
  utf8Name,
} from "../../src/notionImport/notionFiles";

const ID = "a0000000000000000000000000000001";
const CENTRAL_HEADER = 0x02014b50;
const STORED_SIZE_OFFSET = 20;
const ORIGINAL_SIZE_OFFSET = 24;
const MEBIBYTE = 1024 * 1024;

function zipFile(name: string, entries: Zippable) {
  return new File([zipSync(entries, { level: 0 })], name);
}

function declaringField(bytes: Uint8Array, offset: number, value: number) {
  const patched = bytes.slice();
  const view = new DataView(patched.buffer);

  for (let at = 0; at + 4 <= patched.length; at++)
    if (view.getUint32(at, true) === CENTRAL_HEADER)
      view.setUint32(at + offset, value, true);

  return patched;
}

function declaringSize(bytes: Uint8Array, size: number) {
  return declaringField(bytes, ORIGINAL_SIZE_OFFSET, size);
}

function inFolder(path: string, text = "") {
  const file = new File([text], path.slice(path.lastIndexOf("/") + 1));

  Object.defineProperty(file, "webkitRelativePath", { value: path });

  return file;
}

async function pathsOf(list: File[]) {
  return (await exportFiles(list)).map((file) => file.path).sort();
}

describe("file types of exported attachments", () => {
  it("maps known extensions case-insensitively and everything else to binary", () => {
    expect(mimeType("Ordner/Foto.JPG")).toBe("image/jpeg");
    expect(mimeType("a.tar.gz")).toBe("application/octet-stream");
    expect(mimeType("rechnung.pdf.exe")).toBe("application/octet-stream");
    expect(mimeType("Ordner.png/datei")).toBe("application/octet-stream");
  });

  it("names the file after the last path segment", async () => {
    const file = asFile({ path: "a/b/Bild.png", blob: new Blob(["x"]) });

    expect(file.name).toBe("Bild.png");
    expect(file.type).toBe("image/png");
    expect(await file.text()).toBe("x");
  });

  it("detects archives by extension only", () => {
    expect(isZip(new File([], "Export.ZIP"))).toBe(true);
    expect(isZip(new File([], "zip.md"))).toBe(false);
  });
});

describe("archive file names", () => {
  it("leaves names alone that are not mis-decoded UTF-8", () => {
    expect(utf8Name("ÿþ")).toBe("ÿþ");
    expect(utf8Name("Übersicht 📎")).toBe("Übersicht 📎");
    expect(utf8Name("plain.md")).toBe("plain.md");
  });
});

describe("unpacking an export", () => {
  it("keeps hostile entry names inside the export", async () => {
    const zip = zipFile("export.zip", {
      "../../etc/passwd": strToU8("x"),
      "/abs/olute.md": strToU8("y"),
      "a/../../../b.md": strToU8("z"),
    });

    expect(await pathsOf([zip])).toEqual([
      "abs/olute.md",
      "b.md",
      "etc/passwd",
    ]);
  });

  it("skips folders and macOS metadata and strips the wrapping folder", async () => {
    const zip = zipFile("export.zip", {
      "Export/": new Uint8Array(),
      "Export/Seite.md": strToU8("# S"),
      "Export/.DS_Store": strToU8("x"),
      "Export/._Seite.md": strToU8("x"),
      "__MACOSX/Export/._Seite.md": strToU8("x"),
      "Export/Unter/Bild.png": strToU8("x"),
    });

    expect(await pathsOf([zip])).toEqual(["Seite.md", "Unter/Bild.png"]);
  });

  it("flattens archives nested inside the export", async () => {
    const inner = zipSync(
      { [`Teil ${ID}.md`]: strToU8("# Teil") },
      { level: 0 },
    );
    const zip = zipFile("export.zip", {
      "Export-Part-1.zip": inner,
      "Bild.png": strToU8("x"),
    });
    const files = await exportFiles([zip]);

    expect(files.map((file) => file.path).sort()).toEqual([
      "Bild.png",
      `Teil ${ID}.md`,
    ]);
    expect(await files.find((f) => f.path.endsWith(".md"))!.blob.text()).toBe(
      "# Teil",
    );
  });

  it("refuses an archive that claims to unpack beyond the limit", async () => {
    const bytes = zipSync({ "a.md": strToU8("klein") }, { level: 0 });
    const zip = new File(
      [declaringSize(bytes, 1024 * MEBIBYTE + 1)],
      "bomb.zip",
    );

    await expect(exportFiles([zip])).rejects.toThrow("Import limit");
  });

  it("counts nested archives against the same unpacking budget", async () => {
    const part = declaringSize(
      zipSync({ "a.md": strToU8("a") }, { level: 0 }),
      600 * MEBIBYTE,
    );
    const within = zipFile("ok.zip", { "eins.zip": part });
    const beyond = zipFile("bomb.zip", {
      "eins.zip": part,
      "zwei.zip": part.slice(),
    });

    expect(await pathsOf([within])).toEqual(["a.md"]);
    await expect(exportFiles([beyond])).rejects.toThrow("Import limit");
  });

  it("counts the stored bytes of an entry that declares no unpacked size", async () => {
    const bytes = declaringSize(
      zipSync({ "a.md": strToU8("klein") }, { level: 0 }),
      0,
    );
    const zip = new File(
      [declaringField(bytes, STORED_SIZE_OFFSET, 1024 * MEBIBYTE + 1)],
      "stored.zip",
    );

    await expect(exportFiles([zip])).rejects.toThrow("Import limit");
  });

  it("keeps archives nested deeper than two levels as plain files", async () => {
    const deepest = zipSync({ "tief.md": strToU8("x") }, { level: 0 });
    const third = zipSync({ "c.zip": deepest }, { level: 0 });
    const second = zipSync({ "b.zip": third }, { level: 0 });
    const zip = zipFile("export.zip", { "a.zip": second });

    expect(await pathsOf([zip])).toEqual(["c.zip"]);
  });

  it("refuses more than 20000 files but ignores metadata files when counting", async () => {
    const many = Array.from({ length: 20001 }, (_, i) => inFolder(`E/${i}.md`));
    const junk = Array.from({ length: 20001 }, (_, i) =>
      inFolder(`E/${i}/.DS_Store`),
    );

    await expect(exportFiles(many)).rejects.toThrow("Import limit");
    expect(await pathsOf([...junk, inFolder("E/a.md")])).toEqual(["a.md"]);
  });

  it("uses the relative folder path of picked files", async () => {
    expect(
      await pathsOf([inFolder("Pick/x/a.md"), inFolder("Pick/b.md")]),
    ).toEqual(["b.md", "x/a.md"]);
  });
});

describe("reading exported pages", () => {
  it("reads markdown and tables, ignores other files and skips oversized pages", async () => {
    const skipped: string[] = [];
    const sources = await readSources(
      [
        { path: `Seite ${ID}.md`, blob: new Blob(["# Seite"]) },
        { path: "Bild.png", blob: new Blob(["png"]) },
        { path: `Notizen.md`, blob: new Blob(["ohne id"]) },
        {
          path: `Gross ${ID}.csv`,
          blob: new Blob([new Uint8Array(8_000_001)]),
        },
        {
          path: `Grenze ${ID}.csv`,
          blob: new Blob([new Uint8Array(8_000_000)]),
        },
      ],
      skipped,
    );

    expect(sources.map((source) => source.path)).toEqual([
      `Seite ${ID}.md`,
      `Grenze ${ID}.csv`,
    ]);
    expect(sources[0].text).toBe("# Seite");
    expect(skipped).toEqual([`Gross ${ID}.csv`]);
  });
});
