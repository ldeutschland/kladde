import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Notebook } from "../../src/notebook/notebook";
import type { T } from "../../src/locale/locale";
import {
  pageLinkSpec,
  setPageLinkContext,
  withLinksHidden,
} from "../../src/editor/pageLinkSpec";

const SECRET = "3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f";
const OPEN = "0b1c2d3e-4f50-4617-8a9b-cdef01234567";
const t = ((key: string) => key) as T;

class FakeElement {
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = "";
  textContent = "";

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  append() {}
}

const editor = {};
const book = {
  pages: new Map([
    [SECRET, { id: SECRET, title: "Gehaltsrunde", archived: null }],
    [OPEN, { id: OPEN, title: "Urlaub", archived: null }],
  ]),
} as unknown as Notebook;

function exported(page: string) {
  const toExternalHTML = pageLinkSpec.implementation.toExternalHTML!;
  const inline = { type: "pageLink", props: { page } };

  const output = toExternalHTML(inline as never, editor as never);

  return output?.dom as unknown as FakeElement;
}

describe("page links handed to the AI", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { createElement: () => new FakeElement() });
    setPageLinkContext(editor, { book, t });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leave out the title and address of hidden pages", () => {
    const hidden = (id: string) => id === SECRET;
    const [secret, open] = withLinksHidden(hidden, () => [
      exported(SECRET),
      exported(OPEN),
    ]);

    expect(secret.textContent).toBe("aiExcludedChip");
    expect(secret.getAttribute("href")).toBeNull();
    expect(open.textContent).toBe("Urlaub");
    expect(open.getAttribute("href")).toBe("kladde:" + OPEN);
  });

  it("keep the title everywhere else, also after a failed conversion", () => {
    const failing = () =>
      withLinksHidden(
        () => true,
        () => {
          throw Error("Umwandlung gescheitert");
        },
      );

    expect(failing).toThrow("Umwandlung gescheitert");
    expect(exported(SECRET).textContent).toBe("Gehaltsrunde");
    expect(exported(SECRET).getAttribute("href")).toBe("kladde:" + SECRET);
  });
});
