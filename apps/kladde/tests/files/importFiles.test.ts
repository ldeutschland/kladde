import { beforeEach, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { translator } from "../../src/locale/locale";

const core = vi.hoisted(() => ({
  files: new Map<string, string>(),
  refuseFiles: false,
}));

vi.mock("../../src/platform/native", () => ({
  fileBase64: async (blob: Blob) =>
    Buffer.from(await blob.arrayBuffer()).toString("base64"),
  command: vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "load_state") return new ArrayBuffer(0);

    if (name === "add_file") {
      if (core.refuseFiles) throw Error("Disk full");
      const id = crypto.randomUUID();

      core.files.set(id, String(args.data));

      return id;
    }

    return undefined;
  }),
}));

vi.mock("../../src/notebook/content", async (importOriginal) =>
  (await import("../support/plainContent")).plainContent(
    await importOriginal(),
  ),
);

const { Notebook } = await import("../../src/notebook/notebook");
const { blocks } = await import("../../src/notebook/content");
const { importFiles, importable } = await import("../../src/files/importFiles");

type Book = Awaited<ReturnType<typeof Notebook.create>>;

function picked(path: string, contents: BlobPart = "", type = "") {
  const file = new File([contents], path.slice(path.lastIndexOf("/") + 1), {
    type,
  });

  Object.defineProperty(file, "webkitRelativePath", {
    value: path.includes("/") ? path : "",
  });

  return file;
}

function sized(name: string, size: number) {
  const file = picked(name);

  Object.defineProperty(file, "size", { value: size });

  return file;
}

function live(book: Book) {
  return [...book.pages.values()].filter((page) => !page.archived);
}

beforeEach(() => {
  core.files = new Map();
  core.refuseFiles = false;
});

describe("which files can be imported", () => {
  it("limits markdown and CSV files to 8 MB", () => {
    expect(importable(sized("a.md", 8_000_000))).toBe(true);
    expect(importable(sized("a.MD", 8_000_001))).toBe(false);
    expect(importable(sized("a.csv", 8_000_001))).toBe(false);
  });

  it("accepts known document and image types regardless of case", () => {
    for (const name of [
      "Scan.PDF",
      "foto.heic",
      "tabelle.xlsx",
      "x.tar.zip",
      "log.txt",
    ])
      expect(importable(picked(name)), name).toBe(true);
  });

  it("refuses executables, web pages and names without an extension", () => {
    for (const name of [
      "setup.exe",
      "seite.html",
      "bild.svg",
      "pdf",
      "script.js",
      "a.pdf.app",
      "md",
    ])
      expect(importable(picked(name)), name).toBe(false);
  });
});

describe("importing files", () => {
  it("rebuilds the picked folder tree below the chosen page", async () => {
    const book = await Notebook.create("Notizbuch");
    const root = book.add("Ziel").id;

    await importFiles(
      book,
      [
        picked("Auswahl/Projekt/Plan.md", "Plan"),
        picked("Auswahl/Projekt/Notizen/Idee.md", "Idee"),
        picked("Auswahl/Lose.md", "Lose"),
      ],
      root,
    );

    const byTitle = new Map(live(book).map((page) => [page.title, page]));

    expect([...byTitle.keys()].sort()).toEqual([
      "Idee",
      "Lose",
      "Notizen",
      "Plan",
      "Projekt",
      "Ziel",
    ]);
    expect(byTitle.get("Projekt")?.parent).toBe(root);
    expect(byTitle.get("Plan")?.parent).toBe(byTitle.get("Projekt")?.id);
    expect(byTitle.get("Notizen")?.parent).toBe(byTitle.get("Projekt")?.id);
    expect(byTitle.get("Idee")?.parent).toBe(byTitle.get("Notizen")?.id);
    expect(byTitle.get("Lose")?.parent).toBe(root);
  });

  it("returns the first imported page and skips files it cannot import", async () => {
    const book = await Notebook.create("Notizbuch");
    const first = await importFiles(book, [
      picked("virus.exe", "MZ"),
      picked("Erste.md", "eins"),
      picked("Zweite.md", "zwei"),
    ]);

    expect(book.pages.get(first)?.title).toBe("Erste");
    expect(
      live(book)
        .map((page) => page.title)
        .sort(),
    ).toEqual(["Erste", "Zweite"]);
    expect(await importFiles(book, [picked("virus.exe")])).toBe("");
  });

  it("refuses more than 1000 files before creating anything", async () => {
    const book = await Notebook.create("Notizbuch");
    const files = Array.from({ length: 1001 }, (_, i) =>
      picked(`n${i}.md`, "x"),
    );

    await expect(importFiles(book, files)).rejects.toThrow("Import limit");
    expect(book.pages.size).toBe(0);
  });

  it("measures the markdown limit in UTF-8 bytes and leaves no page behind", async () => {
    const book = await Notebook.create("Notizbuch");
    const tooLarge = picked("Umlaute.md", "ü".repeat(1_000_001));

    await expect(importFiles(book, [tooLarge])).rejects.toThrow(
      "Markdown too large",
    );
    expect(live(book)).toEqual([]);
  });

  it("stores other files as an attachment page with a matching block", async () => {
    const book = await Notebook.create("Notizbuch");
    const id = await importFiles(book, [
      picked("Foto.png", "PNGDATA", "image/png"),
    ]);
    const entry = await book.load(id);
    const [block] = blocks(entry);
    const url = (block.props as { url: string }).url;
    const stored = url.replace("kladde-file:", "");

    expect(book.pages.get(id)?.title).toBe("Foto.png");
    expect(block.type).toBe("image");
    expect(Buffer.from(core.files.get(stored)!, "base64").toString()).toBe(
      "PNGDATA",
    );
    expect(entry.doc.getMap("files").get(stored)).toMatchObject({
      name: "Foto.png",
      size: 7,
    });
  });

  it("moves the attachment page to the trash when storing the file fails", async () => {
    const book = await Notebook.create("Notizbuch");

    core.refuseFiles = true;
    await expect(
      importFiles(book, [picked("Scan.pdf", "%PDF")]),
    ).rejects.toThrow("Disk full");
    expect(live(book)).toEqual([]);
  });

  it("imports a CSV file as a database and refuses ragged tables", async () => {
    const book = await Notebook.create("Notizbuch");
    const id = await importFiles(book, [
      picked("Liste.csv", "Name,Menge\nÄpfel,3\n"),
    ]);

    expect(book.pages.get(id)).toMatchObject({
      title: "Liste",
      kind: "database",
    });
    await expect(
      importFiles(book, [picked("Kaputt.csv", "A,B\n1,2,3\n")]),
    ).rejects.toThrow("Invalid CSV");
  });

  it("hands archives to the Notion importer, which refuses archives without Notion pages", async () => {
    const book = await Notebook.create("Notizbuch");
    const zip = new File([zipSync({ "Notiz.md": strToU8("x") })], "Export.zip");

    book.settings.set("language", "de");
    await expect(importFiles(book, [zip])).rejects.toThrow(
      translator("de")("notionEmpty"),
    );
    expect(live(book)).toEqual([]);
  });
});
