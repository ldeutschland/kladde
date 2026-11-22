import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  calls: [] as { name: string; args: Record<string, unknown> }[],
  failAt: -1,
}));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
    native.calls.push({ name, args });
    if (native.calls.length - 1 === native.failAt) throw Error("refused");
  }),
  fileBase64: vi.fn(async (blob: Blob) =>
    Array.from(new Uint8Array(await blob.arrayBuffer())).join(","),
  ),
}));

const { restoreBackup } = await import("../../src/files/backup");

function framed(bytes: number[]) {
  const length = new Uint8Array(4);

  new DataView(length.buffer).setUint32(0, bytes.length, true);

  return [...length, ...bytes];
}

function streamed(header: number[], parts: number[][]) {
  const magic = Array.from(new TextEncoder().encode("KLADDE2\n"));
  const bytes = [...magic, ...framed(header), ...parts.flatMap(framed)];

  return new Blob([Uint8Array.from(bytes)]);
}

beforeEach(() => {
  native.calls = [];
  native.failAt = -1;
});

describe("restoring a backup", () => {
  it("sends the header and then each part, marking the last", async () => {
    const progress: number[] = [];
    const file = streamed([9, 9], [[1, 2, 3], [4], [5, 6]]);

    await restoreBackup(file, "geheim", (done) => progress.push(done));
    expect(native.calls).toEqual([
      {
        name: "import_backup_start",
        args: { header: "9,9", password: "geheim" },
      },
      { name: "import_backup_part", args: { data: "1,2,3", last: false } },
      { name: "import_backup_part", args: { data: "4", last: false } },
      { name: "import_backup_part", args: { data: "5,6", last: true } },
    ]);
    expect(progress.at(-1)).toBe(1);
  });

  it("hands an older backup over in one piece", async () => {
    await restoreBackup(new Blob([Uint8Array.of(1, 2, 3)]), "geheim", () => {});
    expect(native.calls).toEqual([
      { name: "import_backup", args: { bytes: "1,2,3", password: "geheim" } },
    ]);
  });

  it("cancels the restore when a part is refused or the file is cut off", async () => {
    native.failAt = 2;
    const file = streamed([9], [[1], [2]]);

    await expect(restoreBackup(file, "geheim", () => {})).rejects.toThrow();
    expect(native.calls.at(-1)?.name).toBe("import_backup_abort");
    native.calls = [];
    native.failAt = -1;
    const cut = file.slice(0, file.size - 1);

    await expect(restoreBackup(cut, "geheim", () => {})).rejects.toThrow();
    expect(native.calls.at(-1)?.name).toBe("import_backup_abort");
  });
});
