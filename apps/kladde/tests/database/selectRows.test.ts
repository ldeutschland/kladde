import { describe, expect, it } from "vitest";
import { rowTint, selectRows, summarize } from "../../src/database/selectRows";
import type {
  Field,
  FieldType,
  Row,
  Rule,
  Tint,
  View,
} from "../../src/database/types";

const TODAY = "2026-11-22";
const TINT_LIMIT = 12;

const baseView: View = {
  id: "v",
  name: "v",
  type: "table",
  filters: [],
  match: "all",
  sort: "",
  descending: false,
  group: "",
  visible: null,
  widths: {},
};

const field = (id: string, type: FieldType): Field => ({
  id,
  name: id,
  type,
  options: [],
});

const row = (
  id: string,
  values: Record<string, string> = {},
  extra: Partial<Row> = {},
): Row => ({ id, title: id, values, ...extra });

const ids = (rows: Row[]) => rows.map((r) => r.id);

function select(
  rows: Row[],
  view: Partial<View>,
  schema: Field[] = [],
  query = "",
) {
  return selectRows(rows, { ...baseView, ...view }, query, schema);
}

describe("row search", () => {
  it("matches title and values case-insensitively, including unicode", () => {
    const rows = [
      row("Straße"),
      row("b", { note: "ÜBER uns" }),
      row("c", { note: "nothing" }),
    ];

    expect(ids(select(rows, {}, [], "STRAßE"))).toEqual(["Straße"]);
    expect(ids(select(rows, {}, [], "über"))).toEqual(["b"]);
  });

  it("treats regex and wildcard characters in the query literally", () => {
    const rows = [row("a.b"), row("axb"), row("(x)*")];

    expect(ids(select(rows, {}, [], "a.b"))).toEqual(["a.b"]);
    expect(ids(select(rows, {}, [], "(x)*"))).toEqual(["(x)*"]);
  });
});

describe("row filters", () => {
  const status = field("status", "select");
  const rows = [
    row("a", { status: "Open", n: "1" }),
    row("b", { status: "Done", n: "2" }),
    row("c", { status: "Open", n: "3" }),
  ];
  const isOpen: Rule = { field: "status", op: "equals", value: "Open" };
  const isDone: Rule = { field: "status", op: "equals", value: "Done" };
  const bigN: Rule = { field: "n", op: "greater", value: "2" };
  const schema = [status, field("n", "number")];

  it("combines extra filter groups with all or any", () => {
    const groups = [{ filters: [bigN], match: "all" as const }];

    expect(ids(select(rows, { filters: [isOpen], groups }, schema))).toEqual([
      "c",
    ]);
    expect(
      ids(
        select(
          rows,
          { filters: [isDone], groups, groupMatch: "any", sort: "n" },
          schema,
        ),
      ),
    ).toEqual(["b", "c"]);
  });

  it("ignores filter groups without rules", () => {
    const groups = [{ filters: [], match: "any" as const }];

    expect(select(rows, { groups, groupMatch: "all" }, schema)).toHaveLength(3);
  });

  it("hides every row for rules on properties that no longer exist", () => {
    const gone: Rule = { field: "deleted", op: "equals", value: "Open" };

    expect(select(rows, { filters: [gone] }, schema)).toEqual([]);
  });

  it("does not mutate the input order", () => {
    const input = [row("b", { n: "2" }), row("a", { n: "1" })];

    select(input, { sort: "n" }, schema);
    expect(ids(input)).toEqual(["b", "a"]);
  });
});

describe("row sorting", () => {
  it("sorts by title with natural number order when no field is set", () => {
    const rows = [row("Item 10"), row("Item 2"), row("item 1")];

    expect(ids(select(rows, {}))).toEqual(["item 1", "Item 2", "Item 10"]);
  });

  it("keeps empty values last in both directions", () => {
    const schema = [field("n", "number")];
    const rows = [row("a", { n: "" }), row("b", { n: "2" }), row("c")];

    expect(ids(select(rows, { sort: "n" }, schema))).toEqual(["b", "a", "c"]);
    expect(ids(select(rows, { sort: "n", descending: true }, schema))).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("sorts unchecked checkboxes together with checked ones", () => {
    const schema = [field("done", "checkbox")];
    const rows = [row("a", { done: "true" }), row("b", { done: "" })];

    expect(ids(select(rows, { sort: "done" }, schema))).toEqual(["b", "a"]);
  });

  it("orders created and edited properties by exact timestamp", () => {
    const schema = [field("made", "created")];
    const day = "2026-11-01";
    const rows = [
      row("late", { made: day }, { created: 300 }),
      row("early", { made: day }, { created: 100 }),
      row("middle", { made: day }, { created: 200 }),
    ];

    expect(ids(select(rows, { sort: "made" }, schema))).toEqual([
      "early",
      "middle",
      "late",
    ]);
  });

  it("breaks ties with secondary keys and then by creation time", () => {
    const schema = [field("group", "text"), field("n", "number")];
    const rows = [
      row("a", { group: "x", n: "1" }, { created: 3 }),
      row("b", { group: "x", n: "2" }, { created: 2 }),
      row("c", { group: "x", n: "2" }, { created: 1 }),
      row("d", { group: "w", n: "9" }, { created: 4 }),
    ];
    const thenSort = [{ field: "n", descending: true }];

    expect(ids(select(rows, { sort: "group", thenSort }, schema))).toEqual([
      "d",
      "c",
      "b",
      "a",
    ]);
  });

  it("sorts numbers numerically rather than as text", () => {
    const schema = [field("n", "number")];
    const rows = ["10", "9", "-1", "100", "0.5"].map((n) => row(n, { n }));

    expect(ids(select(rows, { sort: "n" }, schema))).toEqual([
      "-1",
      "0.5",
      "9",
      "10",
      "100",
    ]);
  });

  it("sorts leftover text in a number property after the numbers", () => {
    const schema = [field("n", "number")];
    const rows = ["5", "abc", "3", "x", "1", "4", "2", "n/a", "0"].map(
      (n, created) => row(n, { n }, { created }),
    );

    expect(ids(select(rows, { sort: "n" }, schema))).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "abc",
      "n/a",
      "x",
    ]);
  });
});

describe("row tints", () => {
  const schema = new Map([["status", field("status", "select")]]);
  const open: Rule = { field: "status", op: "equals", value: "Open" };
  const tinted = (tints: Tint[], values = { status: "Open" }) =>
    rowTint(row("r", values), { ...baseView, tints }, schema, TODAY);

  it("returns the color of the first matching tint", () => {
    const tints: Tint[] = [
      { filters: [{ ...open, value: "Done" }], match: "all", color: 1 },
      { filters: [open], match: "all", color: 4 },
      { filters: [open], match: "all", color: 6 },
    ];

    expect(tinted(tints)).toBe(4);
    expect(tinted(tints, { status: "Later" })).toBeUndefined();
  });

  it("skips tints without rules and with malformed data", () => {
    const tints = [
      { filters: [], match: "all", color: 1 },
      { filters: "status", match: "all", color: 2 },
      null,
      { filters: [open], match: "all", color: 1.5 },
      { filters: [open], match: "any", color: 3 },
    ] as unknown as Tint[];

    expect(tinted(tints)).toBe(3);
  });

  it("wraps large colors into the palette", () => {
    expect(tinted([{ filters: [open], match: "all", color: 20 }])).toBe(2);
  });

  it("only evaluates the first twelve tints", () => {
    const misses = Array.from({ length: TINT_LIMIT }, () => ({
      filters: [{ ...open, value: "Done" }],
      match: "all" as const,
      color: 1,
    }));

    expect(
      tinted([...misses, { filters: [open], match: "all", color: 5 }]),
    ).toBeUndefined();
  });
});

describe("view summary", () => {
  const rows = [
    row("a", { n: "4" }),
    row("b", { n: " " }),
    row("c", { n: "x" }),
    row("d", { n: "-2" }),
    row("e"),
  ];
  const total = (calculation: NonNullable<View["summary"]>["calculation"]) =>
    summarize(rows, { field: "n", calculation });

  it("counts every row but only aggregates numeric values", () => {
    expect(total("count")).toBe(5);
    expect(total("sum")).toBe(2);
    expect(total("average")).toBe(1);
    expect(total("minimum")).toBe(-2);
    expect(total("maximum")).toBe(4);
  });

  it("returns null when nothing numeric is present", () => {
    expect(
      summarize([row("a", { n: "x" })], { field: "n", calculation: "sum" }),
    ).toBeNull();
    expect(summarize([], { field: "n", calculation: "maximum" })).toBeNull();
  });

  it("ignores non-finite numbers", () => {
    const huge = [row("a", { n: "1e400" }), row("b", { n: "1" })];

    expect(summarize(huge, { field: "n", calculation: "sum" })).toBe(1);
  });
});
