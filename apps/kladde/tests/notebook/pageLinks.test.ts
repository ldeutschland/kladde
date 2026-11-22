import { describe, expect, it } from "vitest";
import {
  isValidLink,
  linkedPage,
  pageLink,
  pagesLinkedIn,
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
