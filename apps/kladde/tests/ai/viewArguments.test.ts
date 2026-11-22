import { describe, expect, it } from "vitest";
import { fieldId, ruledView, viewRules } from "../../src/ai/viewArguments";
import type { Field, View } from "../../src/database/types";

const schema: Field[] = [
  { id: "f-status", name: "Status", type: "status", options: ["Open"] },
  { id: "f-due", name: "Due", type: "date", options: [] },
  { id: "f-done", name: "Done", type: "checkbox", options: [] },
];

const saved: View = {
  id: "v",
  name: "All",
  type: "board",
  filters: [{ field: "f-done", op: "unchecked", value: "" }],
  match: "any",
  sort: "f-due",
  descending: true,
  group: "f-status",
  visible: null,
  widths: {},
};

describe("Property references from the model", () => {
  it("resolves properties by id or by name", () => {
    expect(fieldId(schema, "f-due")).toBe("f-due");
    expect(fieldId(schema, "Status")).toBe("f-status");
    expect(fieldId(schema, "")).toBe("");
    expect(fieldId(schema, undefined)).toBe("");
  });

  it("rejects unknown, inherited and oversized property names", () => {
    for (const value of ["status", "__proto__", "constructor", "../f-due"])
      expect(() => fieldId(schema, value), value).toThrow("Unknown property");
    expect(() => fieldId(schema, "x".repeat(201))).toThrow("Invalid text");
    expect(() => fieldId(schema, 7)).toThrow("Invalid text");
  });
});

describe("View rules", () => {
  it("returns defaults when no rules are given", () => {
    expect(viewRules(schema, {})).toEqual({
      filters: [],
      match: "all",
      sort: "",
      descending: false,
    });
  });

  it("maps filter fields to ids and fills missing values", () => {
    const rules = viewRules(schema, {
      filters: [{ field: "Due", op: "between", value: "2026-01-01" }],
      match: "any",
      sort: "Due",
      direction: "desc",
    });

    expect(rules).toEqual({
      filters: [
        { field: "f-due", op: "between", value: "2026-01-01", end: "" },
      ],
      match: "any",
      sort: "f-due",
      descending: true,
    });
  });

  it("accepts only operators that fit the property type", () => {
    expect(() =>
      viewRules(schema, { filters: [{ field: "Done", op: "contains" }] }),
    ).toThrow("Invalid operator");
    expect(() =>
      viewRules(schema, { filters: [{ field: "Status", op: "toString" }] }),
    ).toThrow("Invalid operator");
    expect(
      viewRules(schema, { filters: [{ field: "Done", op: "checked" }] })
        .filters[0].op,
    ).toBe("checked");
  });

  it("rejects malformed modes, directions and filters", () => {
    expect(() => viewRules(schema, { match: "none" })).toThrow(
      "Invalid filter mode",
    );
    expect(() => viewRules(schema, { direction: "up" })).toThrow(
      "Invalid sort direction",
    );
    expect(() => viewRules(schema, { filters: ["Due"] })).toThrow(
      "Invalid object",
    );
    expect(() =>
      viewRules(schema, {
        filters: [{ field: "Due", value: "x".repeat(2001) }],
      }),
    ).toThrow("Invalid text");
    expect(() =>
      viewRules(schema, { filters: [{ field: "Due", value: 5 }] }),
    ).toThrow("Invalid text");
  });
});

describe("Changing a saved view", () => {
  it("keeps every saved setting the call does not mention", () => {
    expect(ruledView(saved, schema, {})).toEqual(saved);
  });

  it("replaces only the settings the call gives", () => {
    const view = ruledView(saved, schema, {
      filters: [{ field: "Status", op: "equals", value: "Open" }],
      group: "Due",
    });

    expect(view.filters).toEqual([
      { field: "f-status", op: "equals", value: "Open", end: "" },
    ]);
    expect(view.group).toBe("f-due");
    expect(view.match).toBe("any");
    expect(view.sort).toBe("f-due");
    expect(view.descending).toBe(true);
  });

  it("fails on unknown properties in filters or group", () => {
    expect(() =>
      ruledView(saved, schema, { filters: [{ field: "Missing" }] }),
    ).toThrow("Unknown property");
    expect(() => ruledView(saved, schema, { group: "Missing" })).toThrow(
      "Unknown property",
    );
  });
});
