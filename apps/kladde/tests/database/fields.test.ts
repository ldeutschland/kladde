import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addView,
  fields,
  newField,
  rowValues,
  validFieldName,
  views,
} from "../../src/database/fields";
import type { Entry } from "../../src/notebook/notebook";

const FIELD_LIMIT = 100;
const OPTION_LIMIT = 500;
const KEY_LIMIT = 200;
const NAME_LIMIT = 200;

function database() {
  const db: Entry = { id: "db", doc: new Y.Doc(), rev: 0, kind: "database" };

  return { db, schema: db.doc.getMap<unknown>("schema") };
}

describe("stored property definitions", () => {
  it("drops definitions with unsafe keys, mismatched ids, unknown types or no name", () => {
    const { db, schema } = database();

    schema.set("ok", { id: "ok", name: "Ok", type: "text" });
    schema.set("__proto__", { id: "__proto__", name: "x", type: "text" });
    schema.set("constructor", { id: "constructor", name: "x", type: "text" });
    schema.set("a", { id: "b", name: "x", type: "text" });
    schema.set("c", { id: "c", name: "x", type: "script" });
    schema.set("d", { id: "d", name: 5, type: "text" });
    schema.set("e", ["e", "x", "text"]);
    schema.set("k".repeat(KEY_LIMIT + 1), {
      id: "k".repeat(KEY_LIMIT + 1),
      name: "x",
      type: "text",
    });

    expect([...fields(db).keys()]).toEqual(["ok"]);
    expect(fields(db).get("a")).toBeUndefined();
    expect(fields(db).has("__proto__")).toBe(false);
  });

  it("keeps only known settings with the right types", () => {
    const { db, schema } = database();

    schema.set("n", {
      id: "n",
      name: "Amount",
      type: "number",
      format: "bitcoin",
      dateFormat: "long",
      rollup: "sum",
      barMax: "100",
      bar: "yes",
      formula: 42,
      prefix: "INV",
      onclick: "alert(1)",
      options: ["a", 1, null, "b"],
    });

    expect(fields(db).get("n")).toEqual({
      id: "n",
      name: "Amount",
      type: "number",
      dateFormat: "long",
      rollup: "sum",
      prefix: "INV",
      options: ["a", "b"],
    });
  });

  it("caps options and the number of properties", () => {
    const { db, schema } = database();
    const options = Array.from({ length: OPTION_LIMIT + 5 }, (_, i) => "o" + i);

    for (let i = 0; i < FIELD_LIMIT + 3; i++)
      schema.set("f" + i, { id: "f" + i, name: "F", type: "select", options });

    expect(fields(db).size).toBe(FIELD_LIMIT);
    expect(fields(db).get("f0")?.options).toHaveLength(OPTION_LIMIT);
  });

  it("returns plain copies that cannot change the stored definition", () => {
    const { db, schema } = database();

    schema.set("t", { id: "t", name: "T", type: "text", options: ["a"] });
    fields(db).get("t")!.options.push("b");

    expect(fields(db).get("t")!.options).toEqual(["a"]);
  });
});

describe("stored row values", () => {
  it("keeps only string values under safe keys", () => {
    const values = rowValues(
      JSON.stringify({
        a: "1",
        b: 2,
        c: null,
        d: { nested: "x" },
        constructor: "x",
        prototype: "x",
        ["k".repeat(KEY_LIMIT + 1)]: "x",
        "": "x",
      }),
    );

    expect({ ...values }).toEqual({ a: "1" });
  });

  it("ignores a __proto__ key and never pollutes prototypes", () => {
    const values = rowValues('{"__proto__":{"polluted":"yes"},"a":"1"}');

    expect(Object.getPrototypeOf(values)).toBeNull();
    expect(Object.keys(values)).toEqual(["a"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(["[]", '"text"', "null", "42"])(
    "returns no values for the non-object %s",
    (json) => expect(Object.keys(rowValues(json))).toEqual([]),
  );

  it("throws on malformed JSON", () => {
    expect(() => rowValues("{")).toThrow();
  });
});

describe("new properties", () => {
  it("validates property names by content and length", () => {
    expect(validFieldName("Name")).toBe(true);
    expect(validFieldName(" \t ")).toBe(false);
    expect(validFieldName("n".repeat(NAME_LIMIT))).toBe(true);
    expect(validFieldName("n".repeat(NAME_LIMIT + 1))).toBe(false);
  });

  it("stores a new property under a fresh id", () => {
    const { db } = database();
    const id = newField(db, "Status", "status", ["Open"], undefined, {
      prefix: "S",
    });

    expect(fields(db).get(id)).toMatchObject({
      id,
      name: "Status",
      type: "status",
      options: ["Open"],
      prefix: "S",
    });
  });

  it("does not let extra settings override the id, name or type", () => {
    const { db } = database();
    const id = newField(db, "Safe", "text", [], undefined, {
      id: "__proto__",
      name: "Evil",
      type: "formula",
    });

    expect(fields(db).get(id)).toMatchObject({
      id,
      name: "Safe",
      type: "text",
    });
  });

  it("rejects blank names, unknown types and more than the property limit", () => {
    const { db } = database();

    expect(() => newField(db, " ", "text")).toThrow("Invalid property");
    expect(() => newField(db, "x", "script" as never)).toThrow(
      "Invalid property",
    );
    for (let i = 0; i < FIELD_LIMIT; i++) newField(db, "f" + i, "text");
    expect(() => newField(db, "one more", "text")).toThrow("Invalid property");
  });

  it("adds a view with neutral defaults", () => {
    const { db } = database();
    const view = addView(db, "Board", "board");

    expect(views(db).get(view.id)).toEqual({
      id: view.id,
      name: "Board",
      type: "board",
      filters: [],
      match: "all",
      sort: "",
      descending: false,
      group: "",
      visible: null,
      widths: {},
    });
  });
});
