import { describe, expect, it } from "vitest";
import {
  convertValue,
  inferColumn,
  mentionIds,
  notionDate,
  parseTable,
  rowKey,
  withoutMentions,
  type Column,
} from "../../src/notionImport/notionTable";

const ROW = "28d72169ee2880d4a096f39e403d92e3";
const OTHER_ROW = "26e72169ee28817789d1e1b30f806f32";
const HOSTILE_LENGTH = 250_000;
const TIME_BUDGET_MS = 1000;
const none = () => undefined;

function column(type: Column["type"]): Column {
  return { name: "Feld", type, options: [], target: "" };
}

describe("parsing exported tables", () => {
  it("refuses a table with an unterminated quote", () => {
    expect(() => parseTable('Name,Notiz\nA,"offen\nB,x')).toThrow(
      "Invalid CSV",
    );
  });

  it("pads short rows and cuts long rows to the header width", () => {
    const table = parseTable("A,B,C\n1\n1,2,3,4,5\n");

    expect(table.rows).toEqual([
      ["1", "", ""],
      ["1", "2", "3"],
    ]);
  });

  it("skips blank lines and copes with an empty file", () => {
    expect(parseTable("A\n\n  \nx\n\n").rows).toEqual([["x"]]);
    expect(parseTable("")).toEqual({ header: [], rows: [] });
  });

  it("keeps formula-like cells as plain text", () => {
    const table = parseTable('Name\n"=HYPERLINK(""http://x"")"\n+1\n');

    expect(table.rows).toEqual([['=HYPERLINK("http://x")'], ["+1"]]);
  });
});

describe("Notion dates", () => {
  it("accepts ISO dates with or without a time", () => {
    expect(notionDate("2024-02-29")).toBe("2024-02-29");
    expect(notionDate("2024/03/01 13:45")).toBe("2024-03-01");
    expect(notionDate("12. Jänner 2025")).toBe("2025-01-12");
  });

  it("rejects impossible days, unknown months and malformed ranges", () => {
    for (const raw of [
      "2025-02-29",
      "2025-13-01",
      "2025-00-10",
      "1. Brumaire 2025",
      "Smarch 3, 2025",
      "3. Mai 2025 → 1. Mai 2025",
      "1. Mai 2025 → 2. Mai 2025 → 3. Mai 2025",
      "1. Mai 2025 → ",
      "morgen",
    ])
      expect(notionDate(raw), raw).toBeNull();
  });

  it("collapses a range that starts and ends on the same day", () => {
    expect(notionDate("May 1, 2025 9:00 AM → May 1, 2025 5:00 PM")).toBe(
      "2025-05-01",
    );
  });
});

describe("mentions and row titles", () => {
  it("extracts lower-cased page ids from Notion links and local export paths", () => {
    const raw =
      `A (https://www.notion.so/A-${ROW.toUpperCase()}?pvs=21), ` +
      `B (Ordner/B%20${OTHER_ROW}.md)`;

    expect(mentionIds(raw)).toEqual([ROW, OTHER_ROW]);
    expect(withoutMentions(raw)).toBe("A, B");
  });

  it("does not treat other links in parentheses as mentions", () => {
    const raw = `Text (https://example.org/${ROW})`;

    expect(mentionIds(raw)).toEqual([]);
    expect(withoutMentions(raw)).toBe(raw);
  });

  it("prefers the id after the last encoded space of an export path", () => {
    const raw = `(Commit%20${OTHER_ROW}%20${ROW}.md)`;

    expect(mentionIds(raw)).toEqual([ROW]);
  });

  it("handles huge cells with unclosed or id-less parentheses in linear time", () => {
    const started = performance.now();
    const unclosed = "(%20" + "a".repeat(HOSTILE_LENGTH);
    const idless = "(" + "%20a".repeat(HOSTILE_LENGTH) + ")";
    const opened = "(%20".repeat(HOSTILE_LENGTH);

    expect(mentionIds(unclosed)).toEqual([]);
    expect(withoutMentions(idless)).toBe(idless);
    expect(withoutMentions(opened)).toBe(opened.trim());
    expect(performance.now() - started).toBeLessThan(TIME_BUDGET_MS);
  });

  it("matches titles regardless of case, spacing and placeholder names", () => {
    expect(rowKey("  Große   Liste ")).toBe(rowKey("große liste"));
    expect(rowKey("Untitled")).toBe("");
    expect(rowKey("ohne Titel")).toBe("");
    expect(rowKey("a@b")).toBe("ab");
  });
});

describe("inferring columns", () => {
  const type = (values: string[], name = "Feld") =>
    inferColumn(name, values, none).type;

  it("treats empty columns as text", () => {
    expect(type(["", "  "])).toBe("text");
  });

  it("recognises dates and e-mail addresses", () => {
    expect(type(["2. Oktober 2025", "2025-10-03"])).toBe("date");
    expect(type(["a@b.de", "c.d@e.org"])).toBe("email");
  });

  it("does not take a list of several URLs for one URL", () => {
    expect(type(["https://a.de, https://b.de"])).toBe("text");
  });

  it("falls back to text when there are too many or too long options", () => {
    const many = Array.from({ length: 26 }, (_, i) => [
      "Ort " + i,
      "Ort " + i,
    ]).flat();
    const long = ["x".repeat(61), "x".repeat(61)];

    expect(type(many)).toBe("text");
    expect(type(long)).toBe("text");
    expect(type(["x".repeat(60), "x".repeat(60)])).toBe("select");
  });

  it("links a relation only when every value points into the same database", () => {
    const link = (id: string) => `R (https://www.notion.so/${id})`;
    const databases = new Map([
      [ROW, "db1"],
      [OTHER_ROW, "db2"],
    ]);
    const lookup = (id: string) => databases.get(id);

    expect(inferColumn("Rel", [link(ROW), link(ROW)], lookup).type).toBe(
      "relation",
    );
    expect(
      inferColumn("Rel", [link(ROW), link(OTHER_ROW)], lookup).type,
    ).not.toBe("relation");
    expect(
      inferColumn("Rel", [link(ROW) + ", " + link(ROW)], lookup).type,
    ).not.toBe("relation");
  });
});

describe("converting values", () => {
  it("drops embedded data URIs", () => {
    expect(
      convertValue(
        column("text"),
        " data:text/html;base64,PHNjcmlwdD4= ",
        none,
      ),
    ).toBe("");
  });

  it("caps text values at 8192 characters", () => {
    expect(convertValue(column("text"), "a".repeat(10000), none)).toHaveLength(
      8192,
    );
  });

  it("maps checkboxes, unparsable dates and unknown relation targets", () => {
    expect(convertValue(column("checkbox"), "Yes", none)).toBe("true");
    expect(convertValue(column("checkbox"), "yes", none)).toBe("false");
    expect(convertValue(column("date"), "irgendwann", none)).toBe("");
    const known = (id: string) => (id === ROW ? "neu" : undefined);

    expect(
      convertValue(column("relation"), `R (https://notion.so/${ROW})`, known),
    ).toBe("neu");
    expect(convertValue(column("relation"), "ohne Link", known)).toBe("");
    expect(
      convertValue(
        column("relation"),
        `R (https://notion.so/${OTHER_ROW})`,
        known,
      ),
    ).toBe("");
  });
});
