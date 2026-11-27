import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Notebook, Page } from "../../src/notebook/notebook";
import type { T } from "../../src/locale/locale";

const { command } = vi.hoisted(() => ({
  command: vi.fn(async (): Promise<unknown> => undefined),
}));

vi.mock("../../src/platform/native", () => ({ command }));

const { openLink, opensLinks } = await import("../../src/editor/openLink");

const PAGE = "3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f";
const TRASHED = "0b1c2d3e-4f50-4617-8a9b-cdef01234567";
const CHAT = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const UNKNOWN = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

function page(id: string, overrides: Partial<Page> = {}) {
  return { id, title: id, kind: "page", archived: null, ...overrides };
}

function opener() {
  const pages = new Map([
    [PAGE, page(PAGE)],
    [TRASHED, page(TRASHED, { archived: 5 })],
    [CHAT, page(CHAT, { kind: "chat" })],
  ]);

  return {
    book: { pages } as unknown as Notebook,
    t: ((key: string) => key) as T,
    open: vi.fn(),
    notify: vi.fn(),
  };
}

beforeEach(() => {
  command.mockClear();
  command.mockImplementation(async () => undefined);
});

describe("opening links from the editor", () => {
  it("opens listed pages, in a new tab when asked", () => {
    const target = opener();

    openLink(target, "kladde:" + PAGE);
    openLink(target, `kladde://${PAGE.toUpperCase()}/`, true);
    expect(target.open.mock.calls).toEqual([
      [PAGE, false],
      [PAGE, true],
    ]);
    expect(target.notify).not.toHaveBeenCalled();
  });

  it("explains instead of opening trashed, unknown or chat pages", () => {
    const target = opener();

    openLink(target, "kladde:" + TRASHED);
    openLink(target, "kladde:" + UNKNOWN);
    openLink(target, "kladde:" + CHAT);
    expect(target.open).not.toHaveBeenCalled();
    expect(target.notify.mock.calls).toEqual([
      ["pageTrashed"],
      ["pageUnavailable"],
      ["pageUnavailable"],
    ]);
  });

  it("hands web and mail addresses to the native opener", () => {
    const target = opener();

    openLink(target, " https://example.org/a?b=c ");
    openLink(target, "mailto:someone@example.org");
    expect(command.mock.calls).toEqual([
      ["open_web_source", { address: "https://example.org/a?b=c" }],
      ["open_web_source", { address: "mailto:someone@example.org" }],
    ]);
    expect(target.open).not.toHaveBeenCalled();
  });

  it("ignores everything that is neither a page nor a web address", () => {
    const target = opener();

    for (const href of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      `kladde-file:${PAGE}`,
      `kladde:${PAGE}/../geheim`,
      "",
    ])
      openLink(target, href);
    expect(command).not.toHaveBeenCalled();
    expect(target.open).not.toHaveBeenCalled();
    expect(target.notify).not.toHaveBeenCalled();
  });

  it("reports addresses the system refuses to open", async () => {
    const target = opener();

    command.mockRejectedValueOnce(new Error("Invalid source URL"));
    openLink(target, "https://example.org");
    await vi.waitFor(() =>
      expect(target.notify).toHaveBeenCalledWith("linkFailed"),
    );
  });

  it("opens links only where the editor knows how to navigate", () => {
    const { book, t, open, notify } = opener();

    expect(opensLinks(undefined)).toBe(false);
    expect(opensLinks({ book, t })).toBe(false);
    expect(opensLinks({ book, t, open })).toBe(false);
    expect(opensLinks({ book, t, open, notify })).toBe(true);
  });
});
