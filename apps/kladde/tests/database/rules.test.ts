import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  actionsFor,
  applyAutomations,
  assignFreshIds,
  automations,
  automationSteps,
  counters,
  matchesRule,
  needsValue,
  numberRows,
  operators,
  STEP_LIMIT,
  stepError,
  writableField,
  type Automation,
  type AutomationStep,
} from "../../src/database/rules";
import { fields } from "../../src/database/fields";
import type { Field, FieldType, Row, Rule } from "../../src/database/types";
import type { Entry, Notebook, Page } from "../../src/notebook/notebook";

const TODAY = "2026-11-22";
const FILTER_LIMIT = 32;
const VALUE_LIMIT = 8192;

const field = (
  id: string,
  type: FieldType,
  extra: Partial<Field> = {},
): Field => ({ id, name: id, type, options: [], ...extra });

const entry = (id: string, kind: Entry["kind"] = "row"): Entry => ({
  id,
  doc: new Y.Doc(),
  rev: 0,
  kind,
});

const emptyBook = { pages: new Map() } as unknown as Notebook;

function matches(
  raw: string,
  rule: Partial<Rule>,
  type: FieldType = "text",
  extra: Partial<Field> = {},
) {
  const row: Row = { id: "r", title: "Title", values: { f: raw } };

  return matchesRule(
    row,
    { field: "f", value: "", ...rule },
    field("f", type, extra),
    TODAY,
  );
}

describe("rule operators", () => {
  it("offers operators that fit each property type", () => {
    expect(operators("checkbox")).toEqual(["checked", "unchecked"]);
    expect(operators("button")).toEqual([]);
    expect(operators("multi")).toEqual([
      "hasOption",
      "lacksOption",
      "emptyValue",
      "filledValue",
    ]);
    expect(operators("number")).toContain("between");
    expect(operators("text")).not.toContain("greater");
  });

  it("knows which operators need no value", () => {
    expect(needsValue("thisWeek")).toBe(false);
    expect(needsValue("emptyValue")).toBe(false);
    expect(needsValue("pastDays")).toBe(true);
    expect(needsValue("contains")).toBe(true);
  });
});

describe("matching rules", () => {
  it("rejects malformed rules instead of throwing", () => {
    const row: Row = { id: "r", title: "t", values: { f: "x" } };

    for (const rule of [
      null,
      { field: 1, value: "x" },
      { field: "f", value: 1 },
      { field: "f" },
    ])
      expect(matchesRule(row, rule as unknown as Rule)).toBe(false);
  });

  it("never reads inherited object members as cell values", () => {
    const row: Row = { id: "r", title: "t", values: {} };

    for (const key of ["__proto__", "constructor", "toString"])
      expect(matchesRule(row, { field: key, value: "" })).toBe(false);
  });

  it("does not match a typed rule whose property was deleted", () => {
    const row: Row = { id: "r", title: "t", values: { gone: "x" } };

    expect(
      matchesRule(row, { field: "gone", op: "contains", value: "x" }),
    ).toBe(false);
  });

  it("searches case-insensitively without an operator", () => {
    expect(matches("Hello World", { op: undefined, value: "WORLD" })).toBe(
      true,
    );
  });

  it("applies text operators to the title when no field is given", () => {
    const row: Row = { id: "r", title: "Quarterly Report", values: {} };

    expect(
      matchesRule(row, { field: "", op: "startsWith", value: "quarter" }),
    ).toBe(true);
    expect(matchesRule(row, { field: "", op: "endsWith", value: "x" })).toBe(
      false,
    );
  });

  it("rejects operators that do not belong to the property type", () => {
    expect(matches("5", { op: "greater", value: "1" }, "text")).toBe(false);
    expect(matches("true", { op: "checked" }, "text")).toBe(false);
    expect(matches("x", { op: "hasOption", value: "x" }, "select")).toBe(false);
  });

  it("treats empty search terms as no match for text operators", () => {
    expect(matches("abc", { op: "contains", value: "" })).toBe(false);
    expect(matches("abc", { op: "notContains", value: "" })).toBe(false);
  });

  it("checks presence and checkbox states", () => {
    expect(matches("", { op: "emptyValue" })).toBe(true);
    expect(matches("x", { op: "filledValue" })).toBe(true);
    expect(matches("", { op: "unchecked" }, "checkbox")).toBe(true);
    expect(matches("false", { op: "unchecked" }, "checkbox")).toBe(true);
    expect(matches("true", { op: "checked" }, "checkbox")).toBe(true);
    expect(matches("yes", { op: "checked" }, "checkbox")).toBe(false);
  });

  it("compares numbers and requires both bounds for between", () => {
    expect(matches("10", { op: "greater", value: "9" }, "number")).toBe(true);
    expect(matches("10", { op: "atMost", value: "10" }, "number")).toBe(true);
    expect(matches("10", { op: "equals", value: "1e1" }, "number")).toBe(true);
    expect(
      matches("5", { op: "between", value: "1", end: "5" }, "number"),
    ).toBe(true);
    expect(matches("5", { op: "between", value: "1" }, "number")).toBe(false);
    expect(
      matches("5", { op: "between", value: "1", end: "x" }, "number"),
    ).toBe(false);
    expect(matches("5", { op: "less", value: " " }, "number")).toBe(false);
    expect(matches("abc", { op: "less", value: "9" }, "number")).toBe(false);
  });

  it("compares numeric formula results as numbers and text results as text", () => {
    expect(matches("10", { op: "greater", value: "9" }, "formula")).toBe(true);
    expect(matches("ten", { op: "greater", value: "9" }, "formula")).toBe(
      false,
    );
    expect(matches("ten", { op: "contains", value: "TE" }, "formula")).toBe(
      true,
    );
  });

  it("matches options exactly and relations by id", () => {
    expect(matches("a, bc", { op: "hasOption", value: "bc" }, "multi")).toBe(
      true,
    );
    expect(matches("a, bc", { op: "hasOption", value: "b" }, "multi")).toBe(
      false,
    );
    expect(matches("a, bc", { op: "lacksOption", value: "b" }, "multi")).toBe(
      true,
    );
    expect(matches("r1,r22", { op: "equals", value: "r2" }, "relation")).toBe(
      false,
    );
    expect(
      matches("r1,r22", { op: "notEquals", value: "r2" }, "relation"),
    ).toBe(true);
  });
});

describe("matching dates", () => {
  const date = (raw: string, rule: Partial<Rule>) => matches(raw, rule, "date");

  it("finds the current week from Monday to Sunday", () => {
    expect(date("2026-11-16", { op: "thisWeek" })).toBe(true);
    expect(date("2026-11-22", { op: "thisWeek" })).toBe(true);
    expect(date("2026-11-15", { op: "thisWeek" })).toBe(false);
    expect(date("2026-11-23", { op: "thisWeek" })).toBe(false);
  });

  it("matches ranges that overlap the month or year", () => {
    expect(date("2026-10-25/2026-11-02", { op: "thisMonth" })).toBe(true);
    expect(date("2026-10-01/2026-10-31", { op: "thisMonth" })).toBe(false);
    expect(date("2025-12-31/2026-01-01", { op: "thisYear" })).toBe(true);
  });

  it("includes today in past and next day windows", () => {
    expect(date("2026-11-16", { op: "pastDays", value: "7" })).toBe(true);
    expect(date("2026-11-15", { op: "pastDays", value: "7" })).toBe(false);
    expect(date("2026-11-28", { op: "nextDays", value: "7" })).toBe(true);
    expect(date("2026-11-29", { op: "nextDays", value: "7" })).toBe(false);
    expect(date(TODAY, { op: "today" })).toBe(true);
  });

  it.each(["0", "-3", "1.5", "3651", "abc"])(
    "rejects the day window %j",
    (value) => expect(date(TODAY, { op: "pastDays", value })).toBe(false),
  );

  it("compares against a reference day and a range", () => {
    expect(date("2026-11-01", { op: "beforeDate", value: "2026-11-02" })).toBe(
      true,
    );
    expect(
      date("2026-11-01/2026-11-05", { op: "equals", value: "2026-11-03" }),
    ).toBe(true);
    expect(
      date("2026-11-04", {
        op: "between",
        value: "2026-11-01",
        end: "2026-11-04",
      }),
    ).toBe(true);
    expect(date("2026-11-04", { op: "between", value: "2026-11-01" })).toBe(
      false,
    );
  });

  it("never matches impossible stored or reference days", () => {
    expect(date("2026-02-30", { op: "thisYear" })).toBe(false);
    expect(date("garbage", { op: "thisYear" })).toBe(false);
    expect(date("2026-11-01", { op: "afterDate", value: "2026-13-01" })).toBe(
      false,
    );
  });
});

describe("automation steps", () => {
  const rule = (extra: Partial<Automation>): Automation => ({
    id: "a",
    name: "a",
    enabled: true,
    trigger: "manual",
    watch: "",
    filters: [],
    match: "all",
    field: "f",
    action: "set",
    value: "legacy",
    ...extra,
  });

  it("falls back to the single legacy action when no steps are stored", () => {
    expect(automationSteps(rule({ actions: [] }))).toEqual([
      { field: "f", action: "set", value: "legacy" },
    ]);
  });

  it("drops malformed and oversized steps", () => {
    const actions = [
      { field: "f", action: "set", value: "ok" },
      { field: "f", action: "eval", value: "x" },
      { field: 1, action: "set", value: "x" },
      { field: "f", action: "set", value: "x".repeat(VALUE_LIMIT + 1) },
      null,
    ] as unknown as AutomationStep[];

    expect(automationSteps(rule({ actions }))).toEqual([actions[0]]);
  });

  it("caps the number of steps", () => {
    const actions = Array.from({ length: STEP_LIMIT + 4 }, (_, i) => ({
      field: "f",
      action: "set" as const,
      value: String(i),
    }));

    expect(automationSteps(rule({ actions }))).toHaveLength(STEP_LIMIT);
  });

  it("offers actions per type and locks computed properties", () => {
    expect(actionsFor(undefined)).toEqual([]);
    expect(actionsFor("number")).toContain("increment");
    expect(actionsFor("date")).toEqual(
      expect.arrayContaining(["stamp", "dateOffset"]),
    );
    expect(actionsFor("select")).not.toContain("append");
    expect(writableField(field("x", "formula"))).toBe(false);
    expect(writableField(field("x", "autoId"))).toBe(false);
    expect(writableField(undefined)).toBe(false);
    expect(writableField(field("x", "relation"))).toBe(true);
  });
});

describe("step errors", () => {
  const schema = [
    field("n", "number"),
    field("d", "date"),
    field("u", "url"),
    field("tags", "multi", { options: ["a", "b"] }),
    field("t", "text"),
  ];
  const error = (id: string, action: AutomationStep["action"], value = "") =>
    stepError(
      { field: id, action, value },
      schema.find((f) => f.id === id)!,
      schema,
      emptyBook,
    );

  it("accepts valid steps", () => {
    expect(error("n", "increment", "-1.5")).toBe("");
    expect(error("d", "dateOffset", "-3650")).toBe("");
    expect(error("t", "copy", "n")).toBe("");
    expect(error("tags", "addOption", "a")).toBe("");
    expect(error("u", "set", "https://x.org")).toBe("");
  });

  it("explains invalid steps", () => {
    expect(error("t", "increment", "1")).toMatch(/^allows only /);
    expect(error("t", "copy", "t")).toBe("cannot copy a property onto itself");
    expect(error("t", "copy", "__proto__")).toBe("copies an unknown property");
    expect(error("n", "increment", "Infinity")).toBe("expects a number");
    expect(error("d", "dateOffset", "3651")).toMatch(/whole days/);
    expect(error("d", "dateOffset", "1.5")).toMatch(/whole days/);
    expect(error("tags", "removeOption", "c")).toMatch(/expects one of/);
    expect(error("n", "formula", "  ")).toBe("needs a formula");
    expect(error("t", "append")).toBe("needs text to append");
    expect(error("t", "set")).toMatch(/needs a value/);
    expect(error("u", "set", "javascript:alert(1)")).toBe("Invalid URL");
  });
});

describe("automatic ids", () => {
  function database() {
    const db = entry("db", "database");

    fields(db).set("id", field("id", "autoId"));

    return db;
  }

  it.each([-4, 1.5, "x", Number.MAX_SAFE_INTEGER + 2])(
    "restarts from one when the stored counter is %j",
    (stored) => {
      const db = database();
      const row = entry("r");

      counters(db).set("id", stored as number);
      assignFreshIds(db, row);
      expect(row.doc.getMap("properties").get("id")).toBe("1");
    },
  );

  it("numbers live rows of the database by order and stores the counter", async () => {
    const db = database();
    const loaded = new Map<string, Entry>();
    const page = (id: string, order: number, extra: Partial<Page> = {}) => [
      id,
      { id, kind: "row", parent: "db", order, archived: null, ...extra },
    ];
    const book = {
      pages: new Map([
        page("c", 2),
        page("b", 1),
        page("a", 1),
        page("gone", 0, { archived: 5 }),
        page("other", 0, { parent: "elsewhere" }),
      ] as [string, Page][]),
      load: async (id: string) =>
        loaded.get(id) ?? loaded.set(id, entry(id)).get(id)!,
      flush: async () => {},
    } as unknown as Notebook;

    await numberRows(book, db, "id");
    const numbered = Object.fromEntries(
      [...loaded].map(([id, e]) => [id, e.doc.getMap("properties").get("id")]),
    );

    expect(numbered).toEqual({ a: "1", b: "2", c: "3" });
    expect(counters(db).get("id")).toBe(3);
  });
});

describe("running automations", () => {
  function setup(rule: Partial<Automation>, schema: Field[]) {
    const db = entry("db", "database");
    const row = entry("row");

    for (const f of schema) fields(db).set(f.id, f);
    automations(db).set("a", {
      id: "a",
      name: "a",
      enabled: true,
      trigger: "change",
      watch: "",
      filters: [],
      match: "all",
      field: "",
      action: "set",
      value: "",
      ...rule,
    });
    const run = (changed: string[] = [], only?: string) =>
      applyAutomations(
        emptyBook,
        db,
        row,
        "Row",
        rule.trigger ?? "change",
        new Set(changed),
        only,
      );

    return { row, run, props: row.doc.getMap<string>("properties") };
  }

  const setText: AutomationStep = { field: "t", action: "set", value: "hit" };

  it("only runs rules that are enabled with a literal true", () => {
    const { run, props } = setup(
      { enabled: "true" as unknown as boolean, actions: [setText] },
      [field("t", "text")],
    );

    run();
    expect(props.get("t")).toBeUndefined();
  });

  it("runs change rules only when the watched property changed", () => {
    const { run, props } = setup({ watch: "w", actions: [setText] }, [
      field("t", "text"),
      field("w", "text"),
    ]);

    run(["other"]);
    expect(props.get("t")).toBeUndefined();
    run(["w"]);
    expect(props.get("t")).toBe("hit");
  });

  it("refuses rules with too many filters or an unknown match mode", () => {
    const filters = Array.from({ length: FILTER_LIMIT + 1 }, () => ({
      field: "",
      value: "",
    }));
    const schema = [field("t", "text")];
    const tooMany = setup({ filters, actions: [setText] }, schema);
    const oddMatch = setup(
      { match: "some" as "all", actions: [setText] },
      schema,
    );

    tooMany.run();
    oddMatch.run();
    expect(tooMany.props.get("t")).toBeUndefined();
    expect(oddMatch.props.get("t")).toBeUndefined();
  });

  it("skips locked targets and invalid values but keeps later steps", () => {
    const { run, props } = setup(
      {
        actions: [
          { field: "f", action: "set", value: "1" },
          { field: "u", action: "set", value: "javascript:alert(1)" },
          { field: "missing", action: "set", value: "x" },
          setText,
        ],
      },
      [
        field("f", "formula", { formula: "1" }),
        field("u", "url"),
        field("t", "text"),
      ],
    );

    run();
    expect(props.toJSON()).toEqual({ t: "hit" });
  });

  it("runs a manual rule only when asked for by id", () => {
    const { run, props } = setup({ trigger: "manual", actions: [setText] }, [
      field("t", "text"),
    ]);

    run([], "other");
    expect(props.get("t")).toBeUndefined();
    run([], "a");
    expect(props.get("t")).toBe("hit");
  });

  it("toggles, copies and removes options using the current row", () => {
    const { run, props } = setup(
      {
        actions: [
          { field: "done", action: "toggle", value: "" },
          { field: "t", action: "copy", value: "n" },
          { field: "tags", action: "removeOption", value: "a" },
        ],
      },
      [
        field("done", "checkbox"),
        field("t", "text"),
        field("n", "number"),
        field("tags", "multi", { options: ["a", "b"] }),
      ],
    );

    props.set("n", "42");
    props.set("tags", "a,b");
    run();
    expect(props.toJSON()).toEqual({
      done: "true",
      t: "42",
      n: "42",
      tags: "b",
    });
  });
});
