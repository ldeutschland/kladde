import { describe, expect, it } from "vitest";
import { readClip, readInbound } from "../../src/capture/clipper";

const PNG = "iVBORw0KGgoAAAANSUhEUg==";

function clip(overrides: Record<string, unknown> = {}) {
  return {
    url: "http://wiki.intern/seite",
    title: "Seite",
    site: "wiki.intern",
    byline: "",
    published: "",
    markdown: "Text\n\n![](clip-image:0)",
    images: [""],
    ...overrides,
  };
}

function file(overrides: Record<string, unknown> = {}) {
  return {
    name: "a.png",
    mime: "image/png",
    size: 16,
    data: PNG,
    ...overrides,
  };
}

describe("browser clips", () => {
  it("accepts pages from any web address with files sent by the browser", () => {
    const inbound = readInbound({ clip: clip(), files: [file()] });

    expect(inbound.clip.url).toBe("http://wiki.intern/seite");
    expect(inbound.files[0]?.name).toBe("a.png");
  });

  it("requires a public https image when no file came along", () => {
    expect(() => readInbound({ clip: clip(), files: [null] })).toThrow();
    const fetched = readInbound({
      clip: clip({ images: ["https://cdn.example.com/a.png"] }),
      files: [null],
    });

    expect(fetched.files).toEqual([null]);
  });

  it("refuses unsafe addresses and malformed files", () => {
    const bad = [
      { clip: clip({ url: "javascript:alert(1)" }), files: [file()] },
      { clip: clip({ url: "file:///etc/passwd" }), files: [file()] },
      { clip: clip(), files: [file({ name: "../x.png" })] },
      { clip: clip(), files: [file({ mime: "image/svg+xml" })] },
      { clip: clip(), files: [file({ data: "<script>" })] },
      { clip: clip(), files: [file({ size: "16" })] },
      { clip: clip(), files: Array.from({ length: 21 }, () => null) },
      { clip: clip({ title: 5 }), files: [file()] },
      { clip: clip(), files: "x" },
    ];

    for (const value of bad) expect(() => readInbound(value)).toThrow();
  });

  it("keeps URL clips limited to https", () => {
    expect(() =>
      readClip(clip({ images: [], url: "http://example.com/" })),
    ).toThrow();
    expect(
      readClip(clip({ images: [], url: "https://example.com/" })).url,
    ).toBe("https://example.com/");
  });
});
