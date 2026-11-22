import { describe, expect, it } from "vitest";
import {
  buildPlan,
  creationOrder,
  exportName,
  normalizePath,
  resolveHref,
  stripCommonRoot,
} from "../../src/notionImport/notionPlan";
import {
  convertCallouts,
  markdownLinks,
  rewriteLinks,
  splitPage,
} from "../../src/notionImport/notionMarkdown";
import { utf8Name } from "../../src/notionImport/notionFiles";
import {
  convertValue,
  inferColumn,
  notionDate,
  parseTable,
  rowKey,
} from "../../src/notionImport/notionTable";

const PAGE = "26e72169ee28817789d1e1b30f806f32";
const BOARD = "26e72169ee2881509168caace7d5d17e";
const ROW = "28d72169ee2880d4a096f39e403d92e3";
const CHILD = "28e72169ee288116856df9ba44d10965";
const NESTED = "29072169ee288008a468f602189fe8ed";
const DUPLICATE = "29072169ee2880929352fd948466e5d7";

const sources = [
  {
    path: `Tracker ${PAGE}.md`,
    text:
      "# Tracker\n\n" +
      `[Bewerbungen](Tracker/Bewerbungen%20${BOARD}.csv)\n\n` +
      `[Stelle (m/w/d)](Tracker/Stelle%20(m%20w%20d)%20${CHILD}.md)\n\n` +
      `[Liste](Tracker/Liste%20${DUPLICATE}.md)\n`,
  },
  {
    path: `Tracker/Bewerbungen ${BOARD}.csv`,
    text: "﻿Unternehmen,Status\r\nKreis RE ,Beworben\r\nUnbekannt,Absage\n",
  },
  {
    path: `Tracker/Bewerbungen ${BOARD}_all.csv`,
    text: "﻿Unternehmen,Status\r\nKreis RE ,Beworben\r\nUnbekannt,Absage\n",
  },
  {
    path: `Tracker/Bewerbungen/Kreis RE ${ROW}.md`,
    text: "# Kreis RE\n\nStatus: Beworben\n\n# Aktionspunkte\n",
  },
  {
    path: `Tracker/Stelle (m w d) ${CHILD}.md`,
    text: "# Stelle (m/w/d)\n\nText",
  },
  { path: `Tracker/Liste ${DUPLICATE}.md`, text: "# Liste\n" },
  {
    path: `Tracker/Liste 2907-e5d7/Plan ${NESTED}.md`,
    text: "# Plan\n",
  },
];

describe("Notion export paths", () => {
  it("reads IDs, complete tables and extensions from file names", () => {
    expect(exportName(`a/Bewerbungen ${BOARD}_all.csv`)).toEqual({
      base: "Bewerbungen",
      notionId: BOARD,
      complete: true,
      extension: "csv",
    });
    expect(exportName("Bild.png")).toBeNull();
  });
  it("resolves encoded links with parentheses inside the export only", () => {
    expect(
      resolveHref(`Tracker ${PAGE}.md`, "Tracker/Stelle%20(m%20w%20d).md"),
    ).toBe("Tracker/Stelle (m w d).md");
    expect(resolveHref("a/b.md", "../../../../etc/passwd")).toBe("etc/passwd");
    expect(normalizePath("a /./b/../c")).toBe("a/c");
  });
  it("repairs UTF-8 names from archives without the UTF-8 flag", () => {
    expect(utf8Name("f\u00c3\u00bcr")).toBe("für");
    expect(utf8Name("Caf\u00e9")).toBe("Café");
    expect(utf8Name("für")).toBe("für");
  });
  it("removes the folder that wraps a picked export", () => {
    expect(stripCommonRoot(["export/a.md", "export/b/c.md"])).toEqual([
      "a.md",
      "b/c.md",
    ]);
    expect(stripCommonRoot(["a.md", "a/b.md"])).toEqual(["a.md", "a/b.md"]);
  });
});

describe("Notion page tree", () => {
  const plan = buildPlan(sources);

  it("nests pages, databases and rows as in Notion", () => {
    expect(plan.nodes.get(BOARD)).toMatchObject({
      kind: "database",
      parent: PAGE,
      title: "Bewerbungen",
    });
    expect(plan.nodes.get(ROW)).toMatchObject({ kind: "row", parent: BOARD });
    expect(plan.nodes.get(CHILD)?.parent).toBe(PAGE);
    expect(plan.nodes.get(NESTED)?.parent).toBe(DUPLICATE);
  });
  it("orders children by their position in the parent page", () => {
    const order = creationOrder(plan).map((n) => n.notionId);

    expect(order.slice(0, 4)).toEqual([PAGE, BOARD, CHILD, DUPLICATE]);
  });
});

describe("Notion markdown", () => {
  it("finds links whose targets contain parentheses", () => {
    const [link] = markdownLinks("[**A**](x/A%20(b).md) rest");

    expect(link).toMatchObject({ label: "**A**", href: "x/A%20(b).md" });
  });
  it("finds links whose file name Notion cut inside parentheses", () => {
    const [link] = markdownLinks("[P (m/w/d)](a/P%20(m%20%20" + CHILD + ".md)");

    expect(link.href).toBe("a/P%20(m%20%20" + CHILD + ".md");
  });
  it("rewrites only the link and keeps the text around it", () => {
    const text = rewriteLinks("vor [A](a.md) nach", () => "[A](kladde:x)");

    expect(text).toBe("vor [A](kladde:x) nach");
  });
  it("separates the title and database properties from the body", () => {
    const parts = splitPage(
      "# Zeile\n\nStatus: Offen\nNotiz: eins\nzwei\n\n## Inhalt",
      new Set(["Status", "Notiz"]),
    );

    expect(parts.body).toBe("## Inhalt");
    expect(parts.properties.get("Notiz")).toBe("eins\nzwei");
    expect(splitPage("# Seite\n\nZiel: Text", new Set()).body).toBe(
      "Ziel: Text",
    );
  });
  it("turns callouts into notes with their icon", () => {
    expect(
      convertCallouts("<aside>\n⚠️\n\n**Achtung** jetzt\n\n</aside>"),
    ).toBe("> ⚠️ **Achtung** jetzt");
    expect(convertCallouts("```\n<aside>\n```")).toBe("```\n<aside>\n```");
  });
});

describe("Notion databases", () => {
  const none = () => undefined;

  it("parses German, English and ranged dates", () => {
    expect(notionDate("2. Oktober 2025 17:00 (MESZ)")).toBe("2025-10-02");
    expect(notionDate("March 4, 2024 9:30 PM")).toBe("2024-03-04");
    expect(notionDate("1. Mai 2025 → 3. Mai 2025")).toBe(
      "2025-05-01/2025-05-03",
    );
    expect(notionDate("31. Februar 2025")).toBeNull();
  });
  it("infers property types from the exported values", () => {
    const type = (name: string, values: string[]) =>
      inferColumn(name, values, none).type;

    expect(type("Beworben", ["Yes", "No"])).toBe("checkbox");
    expect(type("Rang", ["1", "2.5"])).toBe("number");
    expect(type("Link", ["https://a.de"])).toBe("url");
    expect(type("Status", ["Beworben", "Absage"])).toBe("status");
    expect(type("Erledigt", ["Erledigt", "Nicht begonnen"])).toBe("status");
    expect(type("Ort", ["Bochum", "Bochum", "Essen"])).toBe("select");
    expect(type("Firma", ["A AG", "B AG"])).toBe("text");
    expect(type("Tags", ["a, b", "b, c", "a"])).toBe("multi");
    expect(type("Risiko", ["Gering (Allergie, selten)", "Mittel"])).toBe(
      "text",
    );
  });
  it("links relations to rows of another database", () => {
    const value = `Kreis RE (https://www.notion.so/${ROW}?pvs=21)`;
    const column = inferColumn("Stelle", [value], () => BOARD);

    expect(column).toMatchObject({ type: "relation", target: BOARD });
    expect(convertValue(column, value, () => "neu")).toBe("neu");
    const text = inferColumn("Stelle", [value], none);

    expect(convertValue(text, value, none)).toBe("Kreis RE");
  });
  it("reads Notion CSV with mixed line endings and matches row titles", () => {
    const table = parseTable('﻿Name,Notiz\r\n"A ","x\r\ny"\nB,z');

    expect(table.rows).toEqual([
      ["A ", "x\ny"],
      ["B", "z"],
    ]);
    expect(rowKey("A (https://www.notion.so/" + ROW + "?pvs=21) ")).toBe(
      rowKey("@A"),
    );
    expect(rowKey("Unbenannt")).toBe(rowKey(""));
  });
});
