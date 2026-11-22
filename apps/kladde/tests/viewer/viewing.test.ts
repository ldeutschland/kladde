import { describe, expect, it } from "vitest";
import { fileId, isLocalFile, savedName } from "../../src/viewer/viewing";
import type { T } from "../../src/locale/locale";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MAX_NAME = 255;
const t = ((key: string) => key) as T;

describe("local file addresses", () => {
  it("accepts only the exact local file form", () => {
    expect(isLocalFile(`kladde-file:${ID}`)).toBe(true);
    expect(fileId(`kladde-file:${ID}`)).toBe(ID);
  });

  it("rejects look-alikes and injected text around the id", () => {
    const hostile = [
      `https://evil.example/kladde-file:${ID}`,
      `kladde-file:${ID}?x=1`,
      `kladde-file:${ID}\n`,
      ` kladde-file:${ID}`,
      `KLADDE-FILE:${ID}`,
      `kladde-file:${ID.toUpperCase()}`,
      `kladde-file:../../${ID.slice(6)}`,
      "kladde-file:",
      "",
    ];

    for (const url of hostile) expect(isLocalFile(url)).toBe(false);
  });
});

describe("saved file names", () => {
  it("accepts both jpeg spellings for jpeg images", () => {
    expect(savedName("Foto.jpeg", "image/jpeg", false, t)).toBe("Foto.jpeg");
    expect(savedName("Foto.png", "image/jpeg", false, t)).toBe("Foto.jpg");
  });

  it("caps long names but keeps the extension", () => {
    const name = savedName(
      "a".repeat(400) + ".pdf",
      "application/pdf",
      true,
      t,
    );

    expect(name).toHaveLength(MAX_NAME);
    expect(name.endsWith(" (editedCopy).pdf")).toBe(true);
  });

  it("strips only the final extension", () => {
    expect(savedName("Bericht.v2.final", "application/pdf", false, t)).toBe(
      "Bericht.v2.pdf",
    );
    expect(savedName("Archiv.tar.gz", "image/webp", false, t)).toBe(
      "Archiv.tar.webp",
    );
  });
});
