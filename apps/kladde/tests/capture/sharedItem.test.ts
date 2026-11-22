import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ payload: new Uint8Array() }));

vi.mock("../../src/platform/native", () => ({
  command: vi.fn(async () => native.payload.slice().buffer),
}));

const { sharedItem } = await import("../../src/capture/sharedItem");

const MAX_HEADER_BYTES = 4096;
const MAX_SHARED_TEXT = 100000;
const encoder = new TextEncoder();

function packed(header: Uint8Array | string, body: Uint8Array | string) {
  const head = typeof header === "string" ? encoder.encode(header) : header;
  const data = typeof body === "string" ? encoder.encode(body) : body;

  return Uint8Array.from([...head, 0, ...data]);
}

function share(header: unknown, body: Uint8Array | string = "") {
  native.payload = packed(JSON.stringify(header), body);
}

beforeEach(() => {
  native.payload = new Uint8Array();
});

describe("shared items", () => {
  it("reads shared text and links as text", async () => {
    share({ name: "", type: "text/uri-list" }, "https://example.org/ä");

    expect(await sharedItem("s1")).toEqual({
      id: "s1",
      text: "https://example.org/ä",
    });
  });

  it("turns accepted files into a file with the declared name and type", async () => {
    share({ name: "scan.pdf", type: "application/pdf" }, "%PDF");
    const item = await sharedItem("s2");

    expect(item.text).toBe("");
    expect(item.file?.name).toBe("scan.pdf");
    expect(item.file?.type).toBe("application/pdf");
    expect(await item.file?.text()).toBe("%PDF");
  });

  it("rejects payloads without a valid header separator", async () => {
    native.payload = encoder.encode('{"name":"a","type":"text/plain"}');
    await expect(sharedItem("s")).rejects.toThrow("Invalid shared item");
    native.payload = packed("", "text");
    await expect(sharedItem("s")).rejects.toThrow("Invalid shared item");
    native.payload = packed("x".repeat(MAX_HEADER_BYTES + 1), "");
    await expect(sharedItem("s")).rejects.toThrow("Invalid shared item");
  });

  it("rejects malformed headers", async () => {
    native.payload = packed(Uint8Array.from([0xc3, 0x28]), "");
    await expect(sharedItem("s")).rejects.toThrow();
    native.payload = packed("{not json", "");
    await expect(sharedItem("s")).rejects.toThrow();

    for (const header of [
      { name: 1, type: "text/plain" },
      { name: "a" },
      { name: "a", type: ["text/plain"] },
    ]) {
      share(header);
      await expect(sharedItem("s")).rejects.toThrow("Invalid shared item");
    }
  });

  it("refuses oversized text and text that is not valid UTF-8", async () => {
    share({ name: "", type: "text/plain" }, "a".repeat(MAX_SHARED_TEXT + 1));
    await expect(sharedItem("s")).rejects.toThrow("Shared text too large");
    share({ name: "", type: "text/plain" }, "a".repeat(MAX_SHARED_TEXT));
    expect((await sharedItem("s")).text).toHaveLength(MAX_SHARED_TEXT);
    share({ name: "", type: "text/plain" }, Uint8Array.from([0xff, 0xfe]));
    await expect(sharedItem("s")).rejects.toThrow();
  });

  it("refuses file types that are not images, PDFs or opaque data", async () => {
    for (const type of ["text/html", "application/javascript", "image"]) {
      share({ name: "x", type }, "<script>");
      await expect(sharedItem("s")).rejects.toThrow("Unsupported file");
    }
  });
});
