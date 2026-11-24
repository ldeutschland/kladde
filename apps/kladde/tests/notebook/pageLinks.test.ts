import { describe, expect, it } from "vitest";
import {
  isValidLink,
  linkedPage,
  pageIdOf,
  pageLink,
  pagesLinkedIn,
  webLink,
} from "../../src/notebook/links";

const ID = "3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f";
const OTHER = "0b1c2d3e-4f50-4617-8a9b-cdef01234567";

describe("internal page links", () => {
  it("round trips a page id through its link", () => {
    expect(pageLink(ID)).toBe("kladde:" + ID);
    expect(linkedPage(pageLink(ID))).toBe(ID);
  });

  it("accepts the slashed and upper case forms and normalises the id", () => {
    expect(linkedPage(`kladde://${ID}/`)).toBe(ID);
    expect(linkedPage(`  KLADDE:${ID.toUpperCase()}\n`)).toBe(ID);
  });

  it("rejects anything that is not exactly one page id", () => {
    for (const href of [
      `kladde:${ID}/../secret`,
      `kladde:${ID}?x=1`,
      `kladde:${ID}#top`,
      `kladde:${ID.slice(1)}`,
      `kladde:${ID.replaceAll("-", "")}`,
      `kladde-file:${ID}`,
      `kladdex:${ID}`,
      `xkladde:${ID}`,
      ID,
      "kladde:",
    ])
      expect(linkedPage(href), href).toBeNull();
  });
});

describe("links stored with a page", () => {
  it("collects distinct page ids in order of appearance", () => {
    const text = `[a](kladde:${OTHER}) und [b](kladde:${ID}) und kladde:${OTHER}`;

    expect(pagesLinkedIn(text)).toEqual([OTHER, ID]);
  });

  it("ignores file references, non-v4 ids and upper case ids", () => {
    const v1 = "3f2a9c1e-7b4d-1e8a-9c0f-1a2b3c4d5e6f";
    const text = `kladde-file:${ID} kladde:${v1} kladde:${ID.toUpperCase()}`;

    expect(pagesLinkedIn(text)).toEqual([]);
  });
});

describe("page ids stored in references", () => {
  it("accepts exactly one page id and normalises its case", () => {
    expect(pageIdOf(ID)).toBe(ID);
    expect(pageIdOf(ID.toUpperCase())).toBe(ID);
  });

  it("refuses links, fragments and smuggled markup", () => {
    for (const value of [
      pageLink(ID),
      ` ${ID}`,
      ID.slice(1),
      `${ID}) [x](https://example.org`,
      `${ID}"><img src=x>`,
      "",
    ])
      expect(pageIdOf(value), value).toBeNull();
  });
});

describe("web addresses opened outside the app", () => {
  it("trims web and mail addresses", () => {
    expect(webLink(" https://example.org/a?b=c ")).toBe(
      "https://example.org/a?b=c",
    );
    expect(webLink("mailto:someone@example.org")).toBe(
      "mailto:someone@example.org",
    );
  });

  it("refuses page links, scripts and local files", () => {
    for (const href of [
      pageLink(ID),
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://exa mple.org",
      "",
    ])
      expect(webLink(href), href).toBeNull();
  });
});

describe("links allowed in the editor", () => {
  it("allows web, mail and page links", () => {
    for (const href of [
      "https://example.org/a?b=c#d",
      "HTTP://example.org",
      "mailto:someone@example.org",
      ` kladde:${ID} `,
    ])
      expect(isValidLink(href), href).toBe(true);
  });

  it("refuses scripts, local files, data and smuggled whitespace", () => {
    for (const href of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "//example.org",
      "https://",
      "https://exa mple.org",
      "https://example.org\njavascript:alert(1)",
      "ftp://example.org",
      "",
    ])
      expect(isValidLink(href), href).toBe(false);
  });
});
