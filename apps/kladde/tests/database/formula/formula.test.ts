import { describe, it, expect } from "vitest";
import { FormulaError } from "../../../src/database/formula/errors";
import { runFormula } from "../../../src/database/formula/evaluate";
import type { FormulaScope, Value } from "../../../src/database/formula/values";
import {
  calculate,
  computeRows,
  displayValue,
  type ComputeScope,
} from "../../../src/database/compute";
import * as Y from "yjs";
import { fields } from "../../../src/database/fields";
import { selectRows } from "../../../src/database/selectRows";
import { type Field, type Row, type View } from "../../../src/database/types";
import {
  applyAutomations,
  automations,
  matchesRule,
} from "../../../src/database/rules";
import type { Entry } from "../../../src/notebook/notebook";

const scope = (values: Record<string, Value>) =>
  ({
    today: "2026-11-16",
    title: () => "Angebot",
    prop: (name: string) => {
      if (!(name in values)) throw new FormulaError("unknownProperty", name);

      return values[name];
    },
  }) satisfies FormulaScope;

const field = (id: string, type: Field["type"], extra: Partial<Field> = {}) =>
  ({ id, name: id, type, options: [], ...extra }) as Field;

const computeScope: ComputeScope = {
  pageTitle: (id) => ({ r1: "Alpha", r2: "Beta" })[id] ?? "",
  related: new Map(),
  today: "2026-11-16",
};

describe("formulas", () => {
  it("calculates with precedence, text and conditions", () => {
    const values = scope({ Preis: 19.99, Menge: 3, Bezahlt: true });

    expect(runFormula('prop("Preis") * prop("Menge")', values)).toBe(59.97);
    expect(runFormula("1 + 2 * 3 ^ 2", values)).toBe(19);
    expect(runFormula("0.1 + 0.2", values)).toBe(0.3);
    expect(runFormula('if(prop("Bezahlt"), "ok", "offen")', values)).toBe("ok");
    expect(runFormula('title() + " #" + 4', values)).toBe("Angebot #4");
    expect(runFormula("round(10 / 3, 2)", values)).toBe(3.33);
    expect(runFormula('ifs(false, 1, 2 > 3, 2, "sonst")', values)).toBe(
      "sonst",
    );
    expect(runFormula("not true or 1 = 1 and 2 <> 3", values)).toBe(true);
  });

  it("handles dates", () => {
    const values = scope({ Start: "2026-01-31/2026-02-03" });

    expect(runFormula('dateAdd(prop("Start"), 1, "months")', values)).toBe(
      "2026-02-28",
    );
    expect(
      runFormula('dateBetween(today(), prop("Start"), "days")', values),
    ).toBe(289);
    expect(runFormula('dateEnd(prop("Start"))', values)).toBe("2026-02-03");
    expect(runFormula('weekday("2026-11-16")', values)).toBe(1);
    expect(runFormula('week("2026-01-01")', values)).toBe(1);
  });

  it("names values, recovers from errors and formats dates", () => {
    const values = {
      ...scope({ Preis: 100, Datum: "2026-11-16" }),
      lang: "de",
    };

    expect(
      runFormula('let(netto, prop("Preis"), netto * 1.19 - netto)', values),
    ).toBe(19);
    expect(runFormula("lets(a, 2, b, a * 3, a + b)", values)).toBe(8);
    expect(() => runFormula("let(x, 1, y)", values)).toThrow(FormulaError);
    expect(() => runFormula("let(1, 1, 2)", values)).toThrow(FormulaError);
    expect(runFormula('ifError(toNumber("abc"), 0)', values)).toBe(0);
    expect(runFormula('ifError(prop("fehlt"), "–")', values)).toBe("–");
    expect(
      runFormula('formatDate(prop("Datum"), "dddd, D. MMMM YYYY")', values),
    ).toBe("Montag, 16. November 2026");
    expect(
      runFormula('formatDate(prop("Datum"), "[KW] DD.MM.YY")', values),
    ).toBe("KW 16.11.26");
    expect(runFormula('formatDate(prop("Datum"))', values)).toBe(
      "16. November 2026",
    );
  });

  it("splits text and finds positions", () => {
    const values = scope({ Name: "Ada Lovelace" });

    expect(runFormula('split("a; b ;c", ";")', values)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(runFormula('at(split(prop("Name"), " "), -1)', values)).toBe(
      "Lovelace",
    );
    expect(runFormula('count(split("x|y|z", "|"))', values)).toBe(3);
    expect(runFormula('at("a,b", 5)', values)).toBeNull();
    expect(runFormula('indexOf(prop("Name"), "Love")', values)).toBe(4);
    expect(runFormula('indexOf("äöü", "ü")', values)).toBe(2);
    expect(runFormula('indexOf("abc", "z")', values)).toBe(-1);
  });

  it("works with lists, chained calls and callbacks", () => {
    const values = scope({ Tags: ["Design", "Web", "Design"] });

    expect(runFormula("[3, 1, 2].sort()", values)).toEqual([1, 2, 3]);
    expect(runFormula("[1, 2, 3].map(current * 10 + index)", values)).toEqual([
      10, 21, 32,
    ]);
    expect(runFormula("sum([1, 2, 3, 4].filter(current > 2))", values)).toBe(7);
    expect(runFormula('prop("Tags").unique().join(" / ")', values)).toBe(
      "Design / Web",
    );
    expect(runFormula('prop("Tags").includes("Web")', values)).toBe(true);
    expect(runFormula('contains(prop("Tags"), "des")', values)).toBe(false);
    expect(runFormula('contains(prop("Tags"), "design")', values)).toBe(true);
    expect(runFormula("[1, 2, 3].find(current > 1)", values)).toBe(2);
    expect(runFormula("[1, 2, 3].findIndex(current > 5)", values)).toBe(-1);
    expect(runFormula("[1, 2].some(current = 2)", values)).toBe(true);
    expect(runFormula("[1, 2].every(current = 2)", values)).toBe(false);
    expect(runFormula("[[1, 2], [3]].flat().length()", values)).toBe(3);
    expect(runFormula("concat([1], [2, 3]).last()", values)).toBe(3);
    expect(runFormula("[5, 6, 7].slice(1).first()", values)).toBe(6);
    expect(runFormula("[3, 2, 1].reverse()", values)).toEqual([1, 2, 3]);
    expect(runFormula("empty([])", values)).toBe(true);
    expect(runFormula("format([1, 2])", values)).toBe("1, 2");
    expect(() => runFormula("[1].map(missing)", values)).toThrow(FormulaError);
    expect(() =>
      runFormula(
        'repeat("x,", 200).split(",").map(current).map(current)',
        values,
      ),
    ).not.toThrow();
    expect(() =>
      runFormula('split(repeat("ab", 200), "").map(current)', values),
    ).not.toThrow();
    expect(() =>
      runFormula(
        "[1,2,3,4,5,6,7,8,9,10].map([1,2,3,4,5,6,7,8,9,10].map([1,2,3,4,5,6,7,8,9,10].map([1,2,3,4,5,6,7,8,9,10].map(current))))",
        values,
      ),
    ).toThrow(FormulaError);
  });

  it("rejects bad input instead of executing it", () => {
    const values = scope({});

    expect(() => runFormula("constructor()", values)).toThrow(FormulaError);
    expect(() => runFormula('prop("missing")', values)).toThrow(FormulaError);
    expect(() => runFormula("1 +", values)).toThrow(FormulaError);
    expect(() => runFormula('"open', values)).toThrow(FormulaError);
    expect(() =>
      runFormula("(".repeat(80) + "1" + ")".repeat(80), values),
    ).toThrow(FormulaError);
    expect(() => runFormula('repeat("x", 100000)', values)).toThrow(
      FormulaError,
    );
    expect(() => runFormula('"a" * 2', values)).toThrow(FormulaError);
  });
});

describe("computed properties", () => {
  it("chains formulas, detects cycles and rolls up relations", () => {
    const schema = [
      field("net", "number"),
      field("gross", "formula", { formula: 'prop("net") * 1.19' }),
      field("label", "formula", { formula: 'format(prop("gross")) + " €"' }),
      field("loop", "formula", { formula: 'prop("loop") + 1' }),
      field("links", "relation", { target: "other" }),
      field("total", "rollup", {
        relation: "links",
        property: "amount",
        rollup: "sum",
      }),
      field("names", "rollup", { relation: "links", rollup: "showValues" }),
    ];
    const related = new Map([
      [
        "other",
        {
          schema: [field("amount", "number")],
          rows: new Map<string, Row>([
            ["r1", { id: "r1", title: "Alpha", values: { amount: "5" } }],
            ["r2", { id: "r2", title: "Beta", values: { amount: "7.5" } }],
          ]),
        },
      ],
    ]);
    const [row] = computeRows(
      [{ id: "a", title: "A", values: { net: "100", links: "r1,r2" } }],
      schema,
      { ...computeScope, related },
    );

    expect(row.values.gross).toBe("119");
    expect(row.values.label).toBe("119 €");
    expect(row.values.loop).toBe("");
    expect(row.values.total).toBe("12.5");
    expect(row.values.names).toBe("Alpha, Beta");
  });

  it("reads properties of related rows", () => {
    const schema = [
      field("tasks", "relation", { target: "tasks" }),
      field("open", "formula", {
        formula:
          'prop("tasks").filter(not current.prop("Done")).map(current.title())',
      }),
      field("hours", "formula", {
        formula: 'sum(prop("tasks").map(current.prop("Hours")))',
      }),
      field("late", "formula", {
        formula:
          'prop("tasks").some(current.prop("Due") < today() and not current.prop("Done"))',
      }),
    ];
    const related = new Map([
      [
        "tasks",
        {
          schema: [
            field("done", "checkbox", { name: "Done" }),
            field("hours", "number", { name: "Hours" }),
            field("due", "date", { name: "Due" }),
          ],
          rows: new Map<string, Row>([
            [
              "r1",
              {
                id: "r1",
                title: "Alpha",
                values: { done: "true", hours: "2", due: "2026-11-01" },
              },
            ],
            [
              "r2",
              {
                id: "r2",
                title: "Beta",
                values: { done: "false", hours: "3.5", due: "2026-11-10" },
              },
            ],
          ]),
        },
      ],
    ]);
    const [row] = computeRows(
      [{ id: "a", title: "A", values: { tasks: "r1,r2" } }],
      schema,
      { ...computeScope, related },
    );

    expect(row.values.open).toBe("Beta");
    expect(row.values.hours).toBe("5.5");
    expect(row.values.late).toBe("true");
  });

  it("calculates column statistics", () => {
    expect(calculate("sum", ["1", "2", "", "x"])).toBe(3);
    expect(calculate("median", ["4", "1", "3"])).toBe(3);
    expect(calculate("percentFilled", ["a", "", "b", ""])).toBe(50);
    expect(calculate("countUnique", ["a,b", "b", ""])).toBe(2);
    expect(
      calculate("dateRange", ["2026-01-01", "2026-01-11/2026-01-20"]),
    ).toBe(19);
    expect(calculate("percentChecked", ["true", "false", "true", ""])).toBe(50);
  });

  it("formats numbers and IDs", () => {
    expect(
      displayValue(
        field("p", "number", { format: "euro" }),
        "1234.5",
        "de",
        "",
      ),
    ).toMatch(/^1\.234,50\s€$/);
    expect(
      displayValue(
        field("p", "number", { format: "percent" }),
        "0.25",
        "en",
        "",
      ),
    ).toBe("25%");
    expect(
      displayValue(field("i", "autoId", { prefix: "TASK" }), "7", "de", ""),
    ).toBe("TASK-7");
  });

  it("filters and sorts formula results numerically", () => {
    const schema = [field("score", "formula", { formula: "" })];
    const rows = ["10", "9", "100"].map((score, i) => ({
      id: String(i),
      title: "",
      values: { score },
    }));
    const view: View = {
      id: "v",
      name: "v",
      type: "table",
      filters: [{ field: "score", op: "greater", value: "9" }],
      match: "all",
      sort: "score",
      descending: false,
      group: "",
      visible: null,
      widths: {},
    };

    expect(
      selectRows(rows, view, "", schema).map((r) => r.values.score),
    ).toEqual(["10", "100"]);
    expect(
      matchesRule(
        { id: "x", title: "", values: { d: "2026-11-18" } },
        { field: "d", op: "thisWeek", value: "" },
        field("d", "date"),
        "2026-11-16",
      ),
    ).toBe(true);
  });
});

describe("automations", () => {
  it("runs several steps in order and numbers new rows", () => {
    const db = { id: "db", doc: new Y.Doc(), rev: 0, kind: "database" };

    fields(db as Entry).set("n", field("n", "number"));
    fields(db as Entry).set("id", field("id", "autoId"));
    fields(db as Entry).set(
      "tags",
      field("tags", "multi", { options: ["a", "b"] }),
    );
    fields(db as Entry).set("total", field("total", "number"));
    automations(db as Entry).set("r", {
      id: "r",
      name: "r",
      enabled: true,
      trigger: "create",
      watch: "",
      filters: [],
      match: "all",
      field: "n",
      action: "set",
      value: "5",
      actions: [
        { field: "n", action: "set", value: "5" },
        { field: "n", action: "increment", value: "2.5" },
        { field: "tags", action: "addOption", value: "b" },
        { field: "total", action: "formula", value: 'prop("n") * 2' },
        { field: "id", action: "set", value: "99" },
      ],
    });
    const book = { pages: new Map() } as never;
    const first = { id: "a", doc: new Y.Doc(), rev: 0, kind: "row" } as Entry;
    const second = { id: "b", doc: new Y.Doc(), rev: 0, kind: "row" } as Entry;

    applyAutomations(book, db as Entry, first, "A", "create", new Set());
    applyAutomations(book, db as Entry, second, "B", "create", new Set());
    expect(first.doc.getMap("properties").toJSON()).toEqual({
      n: "7.5",
      tags: "b",
      total: "15",
      id: "1",
    });
    expect(second.doc.getMap("properties").get("id")).toBe("2");
  });
});

describe("automations for the agent", () => {
  function linked() {
    const db = { id: "db", doc: new Y.Doc(), rev: 0, kind: "database" };

    fields(db as Entry).set(
      "rel",
      field("rel", "relation", { target: "people" }),
    );
    fields(db as Entry).set("names", field("names", "text"));
    automations(db as Entry).set("r", {
      id: "r",
      name: "r",
      enabled: true,
      trigger: "change",
      watch: "",
      filters: [],
      match: "all",
      field: "names",
      action: "formula",
      value: 'prop("rel")',
      actions: [
        { field: "names", action: "formula", value: 'prop("rel")' },
        { field: "rel", action: "set", value: "r1,r2" },
      ],
    });
    const pages = new Map([
      ["r1", { id: "r1", title: "Alpha", kind: "row", parent: "people" }],
      ["r2", { id: "r2", title: "Beta", kind: "row", parent: "people" }],
    ]);
    const row = { id: "row", doc: new Y.Doc(), rev: 0, kind: "row" } as Entry;

    row.doc.getMap("properties").set("rel", "r1,r2");

    return { db: db as Entry, book: { pages } as never, row };
  }

  it("lets excluded linked rows neither leak titles nor be linked", () => {
    const { db, book, row } = linked();
    const hidden = (id: string) => id === "r2";

    applyAutomations(
      book,
      db,
      row,
      "A",
      "change",
      new Set(["rel"]),
      undefined,
      hidden,
    );
    const props = row.doc.getMap<string>("properties");

    expect(props.get("names")).toContain("Alpha");
    expect(props.get("names")).not.toContain("Beta");
    expect(props.get("rel")).toBe("r1");
  });

  it("keeps the full result for the people who see everything", () => {
    const { db, book, row } = linked();

    applyAutomations(book, db, row, "A", "change", new Set(["rel"]));

    expect(row.doc.getMap<string>("properties").get("names")).toContain("Beta");
  });
});
