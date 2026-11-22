import { describe, expect, it } from "vitest";
import { validValue } from "../../src/database/validValue";
import type { Field, FieldType } from "../../src/database/types";
import type { Notebook, Page } from "../../src/notebook/notebook";

const MAX_LENGTH = 8192;
const RELATION_LIMIT = 100;

const field = (type: FieldType, extra: Partial<Field> = {}): Field => ({
  id: "f",
  name: "f",
  type,
  options: [],
  ...extra,
});

const page = (id: string, kind: Page["kind"], parent: string) =>
  [id, { id, kind, parent }] as const;

function bookWith(entries: (readonly [string, Partial<Page>])[] = []) {
  return { pages: new Map(entries) } as unknown as Notebook;
}

const noBook = bookWith();
const check = (type: FieldType, raw: string, extra: Partial<Field> = {}) =>
  validValue(field(type, extra), raw, noBook);

describe("valid values", () => {
  it("accepts an empty value for every type, even read-only ones", () => {
    for (const type of ["number", "date", "formula", "relation"] as const)
      expect(check(type, "")).toBe("");
  });

  it("enforces the length limit before any type check", () => {
    expect(check("text", "a".repeat(MAX_LENGTH))).toHaveLength(MAX_LENGTH);
    expect(() => check("text", "a".repeat(MAX_LENGTH + 1))).toThrow(
      "Value too long",
    );
    expect(() => check("formula", "a".repeat(MAX_LENGTH + 1))).toThrow(
      "Value too long",
    );
  });

  it.each(["1", "-2.5", "1e3", "0"])("accepts the number %j", (raw) =>
    expect(check("number", raw)).toBe(raw),
  );

  it.each(["abc", "Infinity", "NaN", "1,5", "1e400"])(
    "rejects the number %j",
    (raw) => expect(() => check("number", raw)).toThrow("Invalid number"),
  );

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>",
    "file:///etc/passwd",
    "ftp://x.org",
    " https://x.org",
    "//x.org",
  ])("rejects the URL %j", (raw) =>
    expect(() => check("url", raw)).toThrow("Invalid URL"),
  );

  it("accepts http and https URLs regardless of scheme case", () => {
    expect(check("url", "HTTPS://example.org/a?b=c")).toBe(
      "HTTPS://example.org/a?b=c",
    );
    expect(check("url", "http://localhost")).toBe("http://localhost");
  });

  it("checks emails and phone numbers", () => {
    expect(check("email", "a.b@example.org")).toBe("a.b@example.org");
    expect(() => check("email", "a b@example.org")).toThrow("Invalid email");
    expect(() => check("email", "a@b")).toThrow("Invalid email");
    expect(check("phone", "+49 (30) 123-45.6")).toBe("+49 (30) 123-45.6");
    expect(() => check("phone", "1")).toThrow("Invalid phone");
    expect(() => check("phone", "+49 call me")).toThrow("Invalid phone");
    expect(() => check("phone", "1".repeat(51))).toThrow("Invalid phone");
  });

  it("accepts real days and ordered ranges", () => {
    expect(check("date", "2024-02-29")).toBe("2024-02-29");
    expect(check("date", "2026-01-01/2026-01-01")).toBe(
      "2026-01-01/2026-01-01",
    );
    expect(check("date", "2026-01-01/2026-12-31")).toBe(
      "2026-01-01/2026-12-31",
    );
  });

  it.each([
    "2026-02-30",
    "2025-02-29",
    "2026-13-01",
    "26-01-01",
    "2026-1-1",
    "2026-01-01T10:00",
    "2026-12-31/2026-01-01",
    "2026-01-01/2026-01-02/2026-01-03",
    "2026-01-01/",
  ])("rejects the date %j", (raw) =>
    expect(() => check("date", raw)).toThrow("Invalid date range"),
  );

  it("accepts only exact checkbox literals", () => {
    expect(check("checkbox", "true")).toBe("true");
    expect(check("checkbox", "false")).toBe("false");
    expect(() => check("checkbox", "TRUE")).toThrow("Invalid checkbox");
    expect(() => check("checkbox", "1")).toThrow("Invalid checkbox");
  });

  it("accepts only known options and checks each entry of a list", () => {
    const options = { options: ["Open", "Done"] };

    expect(check("select", "Open", options)).toBe("Open");
    expect(check("multi", "Open, Done", options)).toBe("Open, Done");
    expect(() => check("status", "open", options)).toThrow("Unknown option");
    expect(() => check("multi", "Open,Gone", options)).toThrow(
      "Unknown option",
    );
    expect(() => check("multi", "Open,", options)).toThrow("Unknown option");
    expect(() => check("select", "__proto__", options)).toThrow(
      "Unknown option",
    );
  });

  it.each(["created", "edited", "formula", "rollup", "autoId", "button"])(
    "refuses to store a value in the read-only type %s",
    (type) => expect(() => check(type as FieldType, "1")).toThrow("Read only"),
  );
});

describe("valid relations", () => {
  const relation = field("relation", { target: "people" });

  it("keeps unique ids of rows in the target database", () => {
    const book = bookWith([
      page("r1", "row", "people"),
      page("r2", "row", "people"),
    ]);

    expect(validValue(relation, " r1, r2 ,r1,,", book)).toBe("r1,r2");
  });

  it.each([
    ["a row of another database", page("r1", "row", "other")],
    ["a page that is not a row", page("r1", "page", "people")],
  ])("rejects %s", (_, entry) => {
    expect(() => validValue(relation, "r1", bookWith([entry]))).toThrow(
      "Invalid relation",
    );
  });

  it("rejects unknown ids and relations without a target", () => {
    const book = bookWith([page("r1", "row", "people")]);

    expect(() => validValue(relation, "r1,ghost", book)).toThrow(
      "Invalid relation",
    );
    expect(() => validValue(field("relation"), "r1", book)).toThrow(
      "Invalid relation",
    );
    expect(() => validValue(relation, "__proto__", book)).toThrow(
      "Invalid relation",
    );
  });

  it("allows the link limit and rejects one more distinct row", () => {
    const ids = Array.from({ length: RELATION_LIMIT + 1 }, (_, i) => "r" + i);
    const book = bookWith(ids.map((id) => page(id, "row", "people")));

    expect(
      validValue(relation, ids.slice(0, RELATION_LIMIT).join(","), book),
    ).toBe(ids.slice(0, RELATION_LIMIT).join(","));
    expect(() => validValue(relation, ids.join(","), book)).toThrow(
      "Invalid relation",
    );
  });
});
