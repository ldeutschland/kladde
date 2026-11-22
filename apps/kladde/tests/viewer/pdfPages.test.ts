import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  info: null as unknown,
  calls: [] as [string, unknown][],
}));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: unknown) => {
    native.calls.push([name, args]);

    return native.info;
  }),
}));

const { pdfInfo } = await import("../../src/viewer/pdfPages");

const SOURCE = { space: "book", doc: "page", file: "file" };
const MAX_SIDE = 100_000;

beforeEach(() => {
  native.info = null;
  native.calls = [];
});

describe("pdf page sizes", () => {
  it("returns the page sizes and edit permission from the core", async () => {
    native.info = {
      sizes: [
        [595, 842],
        [842, 595.5],
      ],
      editable: true,
    };

    expect(await pdfInfo(SOURCE)).toEqual({
      sizes: [
        [595, 842],
        [842, 595.5],
      ],
      editable: true,
    });
    expect(native.calls).toEqual([["pdf_pages", SOURCE]]);
  });

  it("treats anything but true as not editable", async () => {
    for (const editable of ["true", 1, undefined]) {
      native.info = { sizes: [[1, 1]], editable };
      expect((await pdfInfo(SOURCE)).editable).toBe(false);
    }
  });

  it("rejects missing, empty or malformed size lists", async () => {
    const hostile: unknown[] = [
      null,
      {},
      { sizes: [] },
      { sizes: "595x842" },
      { sizes: [[595]] },
      { sizes: [[595, 842, 1]] },
      { sizes: [{ 0: 595, 1: 842, length: 2 }] },
    ];

    for (const info of hostile) {
      native.info = info;
      await expect(pdfInfo(SOURCE)).rejects.toThrow("Invalid PDF");
    }
  });

  it("rejects page sides that are not positive, finite and bounded", async () => {
    const sides = [0, -1, NaN, Infinity, MAX_SIDE + 1, "595"];

    for (const side of sides) {
      native.info = {
        sizes: [
          [595, 842],
          [side, 842],
        ],
      };
      await expect(pdfInfo(SOURCE)).rejects.toThrow("Invalid PDF");
    }

    native.info = { sizes: [[MAX_SIDE, 0.5]] };
    await expect(pdfInfo(SOURCE)).resolves.toBeTruthy();
  });
});
