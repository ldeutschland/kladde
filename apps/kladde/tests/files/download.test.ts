import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  tauri: true,
  refuse: false,
  calls: [] as { name: string; args: Record<string, unknown> }[],
  links: [] as { href: string; download: string; clicked: boolean }[],
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => host.tauri }));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async (name: string, args: Record<string, unknown>) => {
    host.calls.push({ name, args });
    if (host.refuse) throw Error("refused");
  }),
  fileBase64: async (blob: Blob) =>
    Buffer.from(await blob.arrayBuffer()).toString("base64"),
}));

const { cleanName, download } = await import("../../src/files/download");

beforeEach(() => {
  host.tauri = true;
  host.refuse = false;
  host.calls = [];
  host.links = [];
  vi.useFakeTimers();
  vi.stubGlobal("document", {
    createElement: () => {
      const link = {
        href: "",
        download: "",
        clicked: false,
        click() {
          link.clicked = true;
        },
      };

      host.links.push(link);

      return link;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("cleaning download names", () => {
  it("removes path separators so a name cannot leave the folder", () => {
    expect(cleanName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(cleanName("..\\..\\boot.ini")).toBe(".._.._boot.ini");
    expect(cleanName("/abs/name.pdf")).toBe("_abs_name.pdf");
  });

  it("replaces control characters, NUL bytes and reserved symbols", () => {
    expect(cleanName('a\0b\nc\td\u202ee:f*g?h"i<j>k|l.txt')).toBe(
      "a_b_c_d_e_f_g_h_i_j_k_l.txt",
    );
  });

  it("keeps letters and digits of any script and ordinary punctuation", () => {
    expect(cleanName("Übersicht (Entwurf) - 2025_v1.0.pdf")).toBe(
      "Übersicht (Entwurf) - 2025_v1.0.pdf",
    );
    expect(cleanName("日本語ノート.md")).toBe("日本語ノート.md");
    expect(cleanName("📎 Anhang")).toBe("_ Anhang");
  });

  it("limits the length to 180 characters", () => {
    expect(cleanName("a".repeat(500))).toHaveLength(180);
  });
});

describe("saving a download", () => {
  it("hands the cleaned name and the bytes to the core in the app", async () => {
    await download("../Bericht.txt", "Inhalt", "text/plain");

    expect(host.calls).toEqual([
      {
        name: "save_download",
        args: {
          name: ".._Bericht.txt",
          data: Buffer.from("Inhalt").toString("base64"),
        },
      },
    ]);
    expect(host.links).toEqual([]);
  });

  it("downloads through the browser outside the app and revokes the URL later", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");

    host.tauri = false;
    await download("a/b.txt", "x", "text/plain");

    expect(host.calls).toEqual([]);
    expect(host.links).toHaveLength(1);
    expect(host.links[0]).toMatchObject({ download: "a_b.txt", clicked: true });
    expect(host.links[0].href).toMatch(/^blob:/);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(revoke).toHaveBeenCalledWith(host.links[0].href);
  });

  it("falls back to the browser when the core refuses", async () => {
    host.refuse = true;
    await download("Notiz.md", "x", "text/markdown");

    expect(host.calls.map((call) => call.name)).toEqual(["save_download"]);
    expect(host.links[0]).toMatchObject({
      download: "Notiz.md",
      clicked: true,
    });
  });
});
