import { describe, it, expect } from "vitest";
import { AgentRun } from "../../src/ai/AgentRun";
import { validateCall } from "../../src/ai/toolArguments";
import { databaseGuide, guideTopics } from "../../src/database/databaseGuide";
import {
  automationFrom,
  checkFormula,
  fieldConfig,
  type ConfigContext,
} from "../../src/database/databaseTools";
import { functionNames } from "../../src/database/formula/functions";
import { automations } from "../../src/database/rules";
import { fields } from "../../src/database/fields";
import { type Field } from "../../src/database/types";
import type { Notebook } from "../../src/notebook/notebook";

const field = (id: string, type: Field["type"], extra: Partial<Field> = {}) =>
  ({ id, name: id, type, options: [], ...extra }) as Field;

const schema = [
  field("price", "number", { name: "Preis" }),
  field("status", "status", { name: "Status", options: ["Offen", "Fertig"] }),
  field("done", "date", { name: "Erledigt am" }),
  field("tasks", "relation", { name: "Aufgaben", target: "tasks" }),
  field("gross", "formula", { name: "Brutto", formula: 'prop("Preis") * 2' }),
];

const scope = {
  pageTitle: () => "",
  related: new Map(),
  today: "2026-11-17",
};

const fakeBook = () =>
  ({
    id: "space",
    pages: new Map(),
    settings: new Map(),
    load: async () => {
      throw Error("Document unavailable");
    },
  }) as unknown as Notebook;

describe("database guide", () => {
  it("documents every formula function and answers each topic", () => {
    const formulas = databaseGuide("formulas").toLowerCase();

    for (const name of functionNames) expect(formulas).toContain(name);
    for (const topic of guideTopics)
      expect(databaseGuide(topic).length).toBeGreaterThan(500);
    expect(databaseGuide("automations")).toContain("thisWeek");
    expect(() => databaseGuide("everything")).toThrow(/formulas/);
  });
});

describe("property settings", () => {
  const context: ConfigContext = {
    schema,
    rules: [],
    targetSchema: async () => [field("hours", "number", { name: "Stunden" })],
  };

  it("maps config keys and resolves rollup references by name", async () => {
    expect(
      await fieldConfig(
        { format: "euro", bar: "true", bar_max: 500 },
        { type: "number" },
        context,
      ),
    ).toEqual({ format: "euro", bar: true, barMax: 500 });
    expect(
      await fieldConfig(
        { relation: "Aufgaben", property: "stunden", rollup: "sum" },
        { type: "rollup" },
        context,
      ),
    ).toEqual({ relation: "tasks", property: "hours", rollup: "sum" });
  });

  it("explains invalid settings", async () => {
    await expect(
      fieldConfig({ format: "money" }, { type: "number" }, context),
    ).rejects.toThrow(/one of: plain, integer/);
    await expect(
      fieldConfig({ prefix: "ID" }, { type: "number" }, context),
    ).rejects.toThrow(/only to autoId/);
    await expect(
      fieldConfig({ colour: 1 }, { type: "number" }, context),
    ).rejects.toThrow(/Unknown config key colour/);
    await expect(
      fieldConfig({ rule: "Start" }, { type: "button" }, context),
    ).rejects.toThrow(/trigger manual/);
  });
});

describe("formula checks", () => {
  const rows = [
    { id: "a", title: "A", values: { price: "10" } },
    { id: "b", title: "B", values: { price: "x" } },
  ];

  it("previews results and reports data problems per row", () => {
    expect(
      checkFormula('prop("Preis") * 2', "Test", schema, rows, scope),
    ).toEqual({
      property: "Test",
      results: [
        { row: "A", value: "20" },
        { row: "B", value: 'error: Not a number: "x"' },
      ],
    });
  });

  it("rejects structural errors with helpful names", () => {
    expect(() =>
      checkFormula('prop("Preiss") * 2', "Test", schema, rows, scope),
    ).toThrow(/Unknown property "Preiss". Properties: "Preis"/);
    expect(() => checkFormula("summe(1)", "Test", schema, [], scope)).toThrow(
      /Unknown function summe/,
    );
    expect(() => checkFormula("Preis * 2", "Test", schema, [], scope)).toThrow(
      /Use prop\("Name"\)/,
    );
  });
});

describe("automation input", () => {
  it("resolves names and validates steps", () => {
    const rule = automationFrom(
      {
        name: "Abschluss",
        trigger: "change",
        watch: "Status",
        filters: [{ field: "status", op: "equals", value: "Fertig" }],
        actions: [{ field: "Erledigt am", action: "stamp" }],
      },
      schema,
      fakeBook(),
    );

    expect(rule).toMatchObject({
      trigger: "change",
      watch: "status",
      filters: [{ field: "status", op: "equals", value: "Fertig" }],
      actions: [{ field: "done", action: "stamp", value: "" }],
      enabled: true,
    });
    const run = (actions: unknown[], filters: unknown[] = []) =>
      automationFrom({ name: "x", actions, filters }, schema, fakeBook());

    expect(() => run([{ field: "Brutto", action: "set", value: "1" }])).toThrow(
      /cannot be changed/,
    );
    expect(() => run([{ field: "Preis", action: "stamp" }])).toThrow(
      /allows only set, clear, copy, formula, increment/,
    );
    expect(() =>
      run([{ field: "Status", action: "set", value: "Unbekannt" }]),
    ).toThrow(/Unknown option/);
    expect(() =>
      run([{ field: "Preis", action: "formula", value: "1 +" }]),
    ).toThrow(/Syntax error/);
    expect(() =>
      run(
        [{ field: "Preis", action: "clear" }],
        [{ field: "Preis", op: "contains", value: "1" }],
      ),
    ).toThrow(/must be one of: equals/);
    expect(
      run([{ field: "Preis", action: "copy", value: "Brutto" }]).actions,
    ).toEqual([{ field: "price", action: "copy", value: "gross" }]);
  });
});

describe("agent database tools", () => {
  it("builds a database with checked formulas, settings and automations", async () => {
    const book = fakeBook();
    const run = new AgentRun(book, null, "propose", async () => "yes", 20);
    const created = (await run.call("create_database", {
      title: "Angebote",
      properties: [
        { name: "Netto", type: "number", config: { format: "euro" } },
        { name: "Status", type: "status", options: ["Offen", "Fertig"] },
        { name: "Erledigt", type: "date" },
        { name: "Brutto", type: "formula", formula: 'prop("Netto") * 1.19' },
      ],
    })) as { id: string };
    const db = run.changes.get(created.id)!.copy;
    const byName = (name: string) =>
      Array.from(fields(db).values()).find((f) => f.name === name)!;

    expect(byName("Netto").format).toBe("euro");

    await expect(
      run.call("update_database_schema", {
        id: created.id,
        change: [{ id: "Brutto", formula: 'prop("Nettto") * 1.19' }],
      }),
    ).rejects.toThrow(/Unknown property "Nettto"/);

    await run.call("update_database_schema", {
      id: created.id,
      change: [
        {
          id: "Brutto",
          formula: 'round(prop("Netto") * 1.19, 2)',
          config: { format: "euro" },
        },
      ],
    });
    const latest = run.changes.get(created.id)!.copy;
    const gross = Array.from(fields(latest).values()).find(
      (f) => f.name === "Brutto",
    )!;

    expect(gross).toMatchObject({
      formula: 'round(prop("Netto") * 1.19, 2)',
      format: "euro",
    });

    const result = (await run.call("set_automation", {
      id: created.id,
      name: "Abschluss",
      trigger: "change",
      watch: "Status",
      filters: [{ field: "Status", op: "equals", value: "Fertig" }],
      actions: [{ field: "Erledigt", action: "stamp" }],
    })) as { automation_id: string };
    const rules = automations(run.changes.get(created.id)!.copy);

    expect(rules.get(result.automation_id)?.name).toBe("Abschluss");

    expect(
      validateCall("set_automation", { id: "x", enabled: "false" }),
    ).toEqual({ id: "x", enabled: false });
  });
});
