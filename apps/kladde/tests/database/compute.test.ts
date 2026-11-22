import { describe, expect, it } from "vitest";
import {
  barRatio,
  calculate,
  calculationsFor,
  compareValues,
  computeRows,
  displayValue,
  evaluateFor,
  formatDate,
  rollupCalculations,
  splitList,
  type ComputeScope,
  type Related,
} from "../../src/database/compute";
import type { Field, FieldType, Row } from "../../src/database/types";

const TODAY = "2026-11-22";
const LIST_LIMIT = 8192;
const collator = new Intl.Collator(undefined, { numeric: true });

const field = (
  id: string,
  type: FieldType,
  extra: Partial<Field> = {},
): Field => ({ id, name: id, type, options: [], ...extra });

const row = (id: string, values: Record<string, string> = {}): Row => ({
  id,
  title: id.toUpperCase(),
  values,
});

const scope = (related = new Map<string, Related>()): ComputeScope => ({
  pageTitle: (id) => ({ p1: "Ada", p2: "Bob" })[id] ?? "",
  related,
  today: TODAY,
  lang: "en",
});

describe("splitting lists", () => {
  it("trims entries and drops empty ones", () => {
    expect(splitList(" a , ,b,, c ")).toEqual(["a", "b", "c"]);
    expect(splitList("")).toEqual([]);
  });
});

describe("calculations", () => {
  it("handles an empty column without dividing by zero", () => {
    expect(calculate("count", [])).toBe(0);
    expect(calculate("percentEmpty", [])).toBeNull();
    expect(calculate("percentChecked", [])).toBeNull();
    expect(calculate("sum", [])).toBeNull();
    expect(calculate("earliest", [])).toBeNull();
  });

  it("treats whitespace as empty and rounds percentages to one decimal", () => {
    expect(calculate("countEmpty", ["", " ", "x"])).toBe(2);
    expect(calculate("percentFilled", ["x", "", ""])).toBe(33.3);
  });

  it("avoids floating point noise in sums and averages", () => {
    expect(calculate("sum", ["0.1", "0.2"])).toBe(0.3);
    expect(calculate("average", ["0.1", "0.2", "0.3"])).toBe(0.2);
    expect(calculate("range", ["0.3", "0.1"])).toBe(0.2);
  });

  it("averages the two middle values for an even median", () => {
    expect(calculate("median", ["4", "1", "3", "10"])).toBe(3.5);
  });

  it("ignores non-numeric and non-finite values in numeric calculations", () => {
    expect(calculate("maximum", ["2", "abc", "1e400", "-3"])).toBe(2);
    expect(calculate("minimum", ["2", "abc", "-3"])).toBe(-3);
  });

  it("uses range starts and ends for date calculations", () => {
    const days = ["2026-03-01/2026-03-10", "2026-01-05", "not a date"];

    expect(calculate("earliest", days)).toBe("2026-01-05");
    expect(calculate("latest", days)).toBe("2026-03-10");
    expect(calculate("dateRange", days)).toBe(64);
  });

  it("counts exact true values as checked", () => {
    expect(calculate("checked", ["true", "TRUE", "1", ""])).toBe(1);
    expect(calculate("unchecked", ["true", "TRUE", "1", ""])).toBe(3);
  });

  it("caps listed values at the text limit", () => {
    const long = ["x".repeat(LIST_LIMIT), "y"];

    expect(calculate("showValues", long)).toHaveLength(LIST_LIMIT);
    expect(calculate("showUnique", ["b, a", "a", ""])).toBe("b, a");
  });
});

describe("available calculations", () => {
  it("offers calculations that fit each property type", () => {
    expect(calculationsFor("checkbox")).toEqual([
      "count",
      "checked",
      "unchecked",
      "percentChecked",
    ]);
    expect(calculationsFor("button")).toEqual(["count"]);
    expect(calculationsFor("text")).not.toContain("sum");
    expect(calculationsFor("created")).toContain("dateRange");
    expect(calculationsFor("formula")).toEqual(
      expect.arrayContaining(["sum", "earliest", "checked"]),
    );
    expect(calculationsFor("text")).not.toContain("showValues");
    expect(rollupCalculations("text")).toContain("showValues");
  });
});

describe("comparing values", () => {
  it("compares numeric computed values as numbers and the rest as text", () => {
    const formula = field("f", "formula");

    expect(compareValues("10", "9", formula, collator)).toBeGreaterThan(0);
    expect(compareValues("b", "a", formula, collator)).toBeGreaterThan(0);
    expect(compareValues("10", "9", field("t", "text"), collator)).toBe(
      collator.compare("10", "9"),
    );
    expect(compareValues("2", "10", undefined, collator)).toBeLessThan(0);
  });
});

describe("progress bars", () => {
  const bar = (extra: Partial<Field>) =>
    field("n", "number", { bar: true, ...extra });

  it("clamps the ratio between zero and one", () => {
    expect(barRatio(bar({}), "50")).toBe(0.5);
    expect(barRatio(bar({}), "250")).toBe(1);
    expect(barRatio(bar({}), "-5")).toBe(0);
    expect(barRatio(bar({ format: "percent" }), "0.25")).toBe(0.25);
  });

  it("falls back to the default maximum for invalid maxima", () => {
    for (const barMax of [0, -10, NaN, Infinity])
      expect(barRatio(bar({ barMax }), "50")).toBe(0.5);
    expect(barRatio(bar({ barMax: 200 }), "50")).toBe(0.25);
  });

  it("shows no bar when disabled, for text or for non-numeric values", () => {
    expect(barRatio(field("n", "number"), "50")).toBeNull();
    expect(barRatio(field("t", "text", { bar: true }), "50")).toBeNull();
    expect(barRatio(bar({}), "abc")).toBeNull();
    expect(barRatio(bar({}), "")).toBeNull();
  });
});

describe("displaying values", () => {
  it("formats date ranges and keeps unparseable days as written", () => {
    expect(formatDate("2026-01-02/2026-01-05", "iso", "en", TODAY)).toBe(
      "2026-01-02 → 2026-01-05",
    );
    expect(formatDate("2026-01-02", "long", "en", TODAY)).toBe(
      "January 2, 2026",
    );
    expect(formatDate("soon", "long", "en", TODAY)).toBe("soon");
  });

  it("describes nearby days relative to today", () => {
    expect(formatDate("2026-11-23", "relative", "en", TODAY)).toBe("tomorrow");
    expect(formatDate("2026-11-01", "relative", "en", TODAY)).toBe(
      "3 weeks ago",
    );
    expect(formatDate("2027-03-22", "relative", "en", TODAY)).toBe(
      "in 4 months",
    );
  });

  it("shows created dates in medium style by default", () => {
    expect(displayValue(field("c", "created"), "2026-11-22", "en", TODAY)).toBe(
      "Nov 22, 2026",
    );
    expect(displayValue(field("d", "date"), "2026-11-22", "en", TODAY)).toBe(
      "2026-11-22",
    );
  });

  it("marks percentage rollups and leaves text untouched", () => {
    expect(
      displayValue(
        field("r", "rollup", { rollup: "percentFilled" }),
        "33.3",
        "en",
        TODAY,
      ),
    ).toBe("33.3 %");
    expect(displayValue(field("t", "text"), "<b>1e3</b>", "en", TODAY)).toBe(
      "<b>1e3</b>",
    );
    expect(displayValue(field("n", "number"), "", "en", TODAY)).toBe("");
  });
});

describe("computing rows", () => {
  const relatedPeople = (): Map<string, Related> =>
    new Map([
      [
        "people",
        {
          schema: [
            field("age", "number", { name: "Age" }),
            field("friends", "relation", { target: "people" }),
          ],
          rows: new Map<string, Row>([
            [
              "p1",
              { id: "p1", title: "Ada", values: { age: "36", friends: "p2" } },
            ],
            ["p2", { id: "p2", title: "Bob", values: { age: "40" } }],
          ]),
        },
      ],
    ]);

  it("returns the same rows when the schema has nothing to compute", () => {
    const rows = [row("a", { t: "x" })];

    expect(computeRows(rows, [field("t", "text")], scope())).toBe(rows);
  });

  it("does not mutate the stored rows", () => {
    const rows = [row("a", { n: "2" })];
    const schema = [
      field("n", "number"),
      field("double", "formula", { formula: 'prop("n") * 2' }),
    ];
    const [computed] = computeRows(rows, schema, scope());

    expect(computed.values.double).toBe("4");
    expect(rows[0].values).toEqual({ n: "2" });
  });

  it("empties formulas that fail and keeps the others", () => {
    const schema = [
      field("bad", "formula", { formula: 'prop("missing") + 1' }),
      field("broken", "formula", { formula: "1 +" }),
      field("good", "formula", { formula: "1 + 1" }),
    ];
    const [computed] = computeRows([row("a")], schema, scope());

    expect(computed.values.bad).toBe("");
    expect(computed.values.broken).toBe("");
    expect(computed.values.good).toBe("2");
  });

  it("rolls up through relations and ignores unknown targets", () => {
    const schema = [
      field("links", "relation", { target: "people" }),
      field("ages", "rollup", {
        relation: "links",
        property: "age",
        rollup: "average",
      }),
      field("friends", "rollup", {
        relation: "links",
        property: "friends",
        rollup: "showValues",
      }),
      field("fallback", "rollup", {
        relation: "links",
        rollup: "nonsense" as never,
      }),
      field("wrongProperty", "rollup", {
        relation: "links",
        property: "deleted",
        rollup: "count",
      }),
      field("noRelation", "rollup", { relation: "ghost", rollup: "count" }),
    ];
    const [computed] = computeRows(
      [row("a", { links: "p1,p2,unknown" })],
      schema,
      scope(relatedPeople()),
    );

    expect(computed.values.ages).toBe("38");
    expect(computed.values.friends).toBe("Bob");
    expect(computed.values.fallback).toBe("Ada, Bob");
    expect(computed.values.wrongProperty).toBe("");
    expect(computed.values.noRelation).toBe("");
  });

  it("evaluates a formula source against a row", () => {
    const schema = [field("n", "number", { name: "Amount" })];

    expect(
      evaluateFor('prop("amount") + 1', row("a", { n: "4" }), schema, scope()),
    ).toBe(5);
    expect(() =>
      evaluateFor('prop("__proto__")', row("a"), schema, scope()),
    ).toThrow();
  });
});
