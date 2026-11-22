import { describe, expect, it } from "vitest";
import {
  buildPlan,
  childrenInOrder,
  creationOrder,
  exportName,
  isWebHref,
  linkedNotionId,
  looksLikeNotionExport,
  normalizePath,
  notionUrlId,
  resolveHref,
  stripCommonRoot,
} from "../../src/notionImport/notionPlan";

const A = "a0000000000000000000000000000001";
const B = "b0000000000000000000000000000002";
const C = "c0000000000000000000000000000003";
const D = "d0000000000000000000000000000004";

describe("normalising archive paths", () => {
  it("keeps traversal and absolute names inside the export", () => {
    expect(normalizePath("../../etc/passwd")).toBe("etc/passwd");
    expect(normalizePath("/etc/passwd")).toBe("etc/passwd");
    expect(normalizePath("a/b/../../../../c")).toBe("c");
    expect(normalizePath("a/..  /b")).toBe("b");
  });

  it("drops empty and dot segments and trailing spaces", () => {
    expect(normalizePath("a//./b /c ")).toBe("a/b/c");
    expect(normalizePath("")).toBe("");
    expect(normalizePath("./..")).toBe("");
  });

  it("composes decomposed characters so equal names match", () => {
    expect(normalizePath("Mu\u0308ller/Ü.md")).toBe(
      normalizePath("Müller/U\u0308.md"),
    );
  });

  it("does not treat backslashes or NUL bytes as separators", () => {
    expect(normalizePath("..\\..\\x.md")).toBe("..\\..\\x.md");
    expect(normalizePath("a\0/b")).toBe("a\0/b");
  });
});

describe("resolving links between exported files", () => {
  it("keeps encoded traversal inside the export", () => {
    expect(
      resolveHref("a/b/page.md", "%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret.md"),
    ).toBe("secret.md");
    expect(resolveHref("a/page.md", "..%2F..%2Fx.md")).toBe("x.md");
  });

  it("drops query and fragment and tolerates broken escapes", () => {
    expect(resolveHref("a/p.md", "b%20c.md?x=1#top")).toBe("a/b c.md");
    expect(resolveHref("a/p.md", "100%.md")).toBe("a/100%.md");
  });

  it("recognises web links case-insensitively", () => {
    expect(
      ["HTTPS://x", "mailto:a@b", "Data:text/plain,x"].every(isWebHref),
    ).toBe(true);
    expect(
      ["javascript:alert(1)", "file:///etc/passwd", "a.md"].some(isWebHref),
    ).toBe(false);
  });

  it("reads page ids from Notion URLs only when they end the path", () => {
    expect(
      notionUrlId(`https://www.notion.so/Seite-${A.toUpperCase()}?pvs=21`),
    ).toBe(A);
    expect(notionUrlId(`https://notion.so/team/${A}#x`)).toBe(A);
    expect(notionUrlId(`https://notion.so/${A}0`)).toBeNull();
    expect(notionUrlId(`https://example.org/${A}`)).toBeNull();
  });

  it("maps a link to a known file, an export name or nothing", () => {
    const byPath = new Map([["Ordner/Ziel.md", B]]);

    expect(linkedNotionId("Start.md", "Ordner/Ziel.md", byPath)).toBe(B);
    expect(linkedNotionId("Start.md", `x/Neu%20${C}.md`, byPath)).toBe(C);
    expect(
      linkedNotionId("Start.md", "javascript:alert(1)", byPath),
    ).toBeNull();
    expect(
      linkedNotionId("Start.md", "https://example.org", byPath),
    ).toBeNull();
  });
});

describe("export names", () => {
  it("normalises the id and extension", () => {
    expect(exportName(`Ordner/Seite ${A.toUpperCase()}.MD`)).toEqual({
      base: "Seite",
      notionId: A,
      complete: false,
      extension: "md",
    });
  });

  it("rejects names without a full id or with another extension", () => {
    expect(exportName(`Seite ${A.slice(1)}.md`)).toBeNull();
    expect(exportName(`Seite ${A}.md.exe`)).toBeNull();
    expect(exportName(`Seite ${A}.html`)).toBeNull();
  });

  it("detects an export only by its markdown pages", () => {
    expect(looksLikeNotionExport([`T ${A}.csv`, "Bild.png"])).toBe(false);
    expect(looksLikeNotionExport(["Bild.png", `Dir/T ${A}.md`])).toBe(true);
  });

  it("strips a shared root folder only when every path is inside it", () => {
    expect(stripCommonRoot(["root/a.md"])).toEqual(["a.md"]);
    expect(stripCommonRoot(["root/a.md", "other/b.md"])).toEqual([
      "root/a.md",
      "other/b.md",
    ]);
    expect(stripCommonRoot(["root/", "root/a.md"])).toEqual([
      "root/",
      "root/a.md",
    ]);
    expect(stripCommonRoot([])).toEqual([]);
  });
});

describe("building the page tree", () => {
  it("lets the first markdown file win when an id appears twice", () => {
    const plan = buildPlan([
      { path: `Eins ${A}.md`, text: "# Erste\n" },
      { path: `Kopie/Eins ${A}.md`, text: "# Zweite\n" },
    ]);

    expect(plan.nodes.size).toBe(1);
    expect(plan.nodes.get(A)).toMatchObject({
      title: "Erste",
      path: `Eins ${A}.md`,
    });
  });

  it("falls back to the file name when the page has no heading", () => {
    const plan = buildPlan([
      { path: `Dateiname ${A}.md`, text: "Text ohne Titel" },
    ]);

    expect(plan.nodes.get(A)?.title).toBe("Dateiname");
  });

  it("names a database after the label of the link to it", () => {
    const plan = buildPlan([
      {
        path: `Start ${A}.md`,
        text: `# Start\n\n[**Aufgaben**](Start/Tabelle%20${B}.csv)`,
      },
      { path: `Start/Tabelle ${B}.csv`, text: "Name\nx\n" },
    ]);

    expect(plan.nodes.get(B)).toMatchObject({
      kind: "database",
      title: "Aufgaben",
      parent: A,
    });
  });

  it("prefers the complete table over the view export", () => {
    const plan = buildPlan([
      { path: `T ${B}.csv`, text: "Name\nsichtbar\n" },
      { path: `T ${B}_all.csv`, text: "Name\nsichtbar\nversteckt\n" },
    ]);

    expect(plan.nodes.get(B)).toMatchObject({
      text: "Name\nsichtbar\nversteckt\n",
      viewTable: "Name\nsichtbar\n",
      path: `T ${B}.csv`,
    });
  });

  it("breaks parent cycles built from hostile '..' page names", () => {
    const plan = buildPlan([
      { path: `A ${A}.md`, text: "# A\n" },
      { path: `A/.. ${B}.md`, text: "# B\n" },
    ]);
    const order = creationOrder(plan).map((node) => node.notionId);

    expect(order).toHaveLength(2);
    expect(new Set(order)).toEqual(new Set([A, B]));

    for (const node of plan.nodes.values()) {
      const seen = new Set<string>();
      let at: string | null = node.notionId;

      while (at) {
        expect(seen.has(at)).toBe(false);
        seen.add(at);
        at = plan.nodes.get(at)?.parent ?? null;
      }
    }
  });

  it("creates parents before children and orders unlinked siblings by title", () => {
    const plan = buildPlan([
      {
        path: `Wurzel ${A}.md`,
        text: `# Wurzel\n\n[Zwei](Wurzel/Zwei%20${C}.md)`,
      },
      { path: `Wurzel/Zwei ${C}.md`, text: "# Zwei\n" },
      { path: `Wurzel/Beta ${D}.md`, text: "# Beta\n" },
      { path: `Wurzel/Alpha ${B}.md`, text: "# Alpha\n" },
    ]);

    expect(childrenInOrder(plan, A).map((node) => node.title)).toEqual([
      "Zwei",
      "Alpha",
      "Beta",
    ]);
    expect(creationOrder(plan).map((node) => node.notionId)).toEqual([
      A,
      C,
      B,
      D,
    ]);
  });
});
