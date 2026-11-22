import { describe, expect, it } from "vitest";
import {
  convertCallouts,
  markdownLinks,
  rewriteLinks,
  splitPage,
  standaloneLines,
} from "../../src/notionImport/notionMarkdown";

const HOSTILE_LENGTH = 200_000;
const TIME_BUDGET_MS = 1000;

describe("finding markdown links", () => {
  it("tells images from links and keeps nested brackets in labels", () => {
    const links = markdownLinks("![Bild](a/b.png) und [a [b] c](x.md)");

    expect(links).toEqual([
      {
        whole: "![Bild](a/b.png)",
        image: true,
        label: "Bild",
        href: "a/b.png",
      },
      {
        whole: "[a [b] c](x.md)",
        image: false,
        label: "a [b] c",
        href: "x.md",
      },
    ]);
  });

  it("does not match links that span lines or contain raw spaces", () => {
    expect(markdownLinks("[a\nb](x.md)")).toEqual([]);
    expect(markdownLinks("[a](x\n.md)")).toEqual([]);
    expect(markdownLinks("[a](x y.md)")).toEqual([]);
  });

  it("scans a long line of opening brackets in linear time", () => {
    const started = performance.now();

    expect(markdownLinks("[".repeat(HOSTILE_LENGTH))).toEqual([]);
    expect(markdownLinks("[a".repeat(HOSTILE_LENGTH))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(TIME_BUDGET_MS);
  });

  it("still finds the inner link when labels nest more than one level", () => {
    expect(markdownLinks("[a [b [c] d](x.md)")).toMatchObject([
      { label: "b [c] d", href: "x.md" },
    ]);
  });

  it("passes script hrefs through as plain data for the caller to judge", () => {
    const [link] = markdownLinks("[klick](javascript:alert(1))");

    expect(link).toMatchObject({ label: "klick", href: "javascript:alert(1)" });
  });
});

describe("rewriting links", () => {
  it("replaces every link and can drop images", () => {
    const text = rewriteLinks(
      "a ![i](i.png) b [l](l.md) c [m](m.md)",
      (link) => (link.image ? "" : `[${link.label}](kladde:${link.href})`),
    );

    expect(text).toBe("a  b [l](kladde:l.md) c [m](kladde:m.md)");
  });

  it("leaves text without links unchanged", () => {
    const text = "kein [Link] hier (oder da)";

    expect(rewriteLinks(text, () => "X")).toBe(text);
  });
});

describe("splitting a Notion page", () => {
  const names = new Set(["Status", "Notiz", "Leer"]);

  it("handles a byte order mark and Windows line endings", () => {
    const parts = splitPage(
      "\ufeff# Titel\r\n\r\nStatus: Offen\r\n\r\nText\r\n",
      names,
    );

    expect(parts.properties.get("Status")).toBe("Offen");
    expect(parts.body).toBe("Text\n");
  });

  it("reads a property without a value", () => {
    const parts = splitPage("# T\n\nLeer:\nStatus: x\n\nBody", names);

    expect(parts.properties.get("Leer")).toBe("");
    expect(parts.properties.get("Status")).toBe("x");
  });

  it("keeps the body intact when the first line is not a known property", () => {
    const parts = splitPage("# T\n\nUnbekannt: 1\nStatus: x\n\nBody", names);

    expect(parts.properties.size).toBe(0);
    expect(parts.body).toBe("Unbekannt: 1\nStatus: x\n\nBody");
  });

  it("does not take a second heading as the title", () => {
    const parts = splitPage("Status: x\n\n# Nicht der Titel", names);

    expect(parts.properties.get("Status")).toBe("x");
    expect(parts.body).toBe("# Nicht der Titel");
  });

  it("returns an empty body for pages that are only properties", () => {
    expect(splitPage("# T\n\nStatus: x", names).body).toBe("");
    expect(splitPage("", names)).toEqual({ properties: new Map(), body: "" });
  });
});

describe("converting callouts", () => {
  it("uses a default icon when the callout does not start with one", () => {
    expect(convertCallouts("<aside>\nHinweis\n</aside>")).toBe("> 💡 Hinweis");
    expect(convertCallouts("<aside>\n\n</aside>")).toBe("> 💡");
  });

  it("keeps compound emoji as the icon and quotes every paragraph", () => {
    expect(
      convertCallouts("<aside>\n👩🏽\u200d💻\n\neins\n\nzwei\n</aside>"),
    ).toBe("> 👩🏽\u200d💻 eins\n>\n> zwei");
  });

  it("closes a callout left open at the end of the page", () => {
    expect(convertCallouts("vor\n<aside>\noffen")).toBe("vor\n> 💡 offen");
  });

  it("ignores a closing tag inside a code block within the callout", () => {
    const text = "<aside>\n```\n</aside>\n```\n</aside>\nnach";

    expect(convertCallouts(text)).toBe("> 💡 ```\n> </aside>\n> ```\nnach");
  });

  it("only treats tags on their own line as callouts", () => {
    const text = "Text <aside>inline</aside> bleibt";

    expect(convertCallouts(text)).toBe(text);
  });
});

describe("standalone lines", () => {
  it("collects trimmed lines", () => {
    expect(standaloneLines("  ![a](b.png)  \n\ttext\n")).toEqual(
      new Set(["![a](b.png)", "text", ""]),
    );
  });
});
