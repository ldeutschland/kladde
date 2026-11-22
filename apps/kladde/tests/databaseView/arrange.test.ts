import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  arrangeRows,
  itemKey,
  layoutKey,
  visibleWindow,
} from "../../src/databaseView/arrange";
import { fields } from "../../src/database/fields";
import type { Field, FieldType, Row, View } from "../../src/database/types";
import type { Entry } from "../../src/notebook/notebook";

const ROW_HEIGHT = 36;
const CARD_HEIGHT = 180;

const field = (id: string, type: FieldType): Field => ({
  id,
  name: id,
  type,
  options: [],
});

const row = (id: string, values: Record<string, string> = {}): Row => ({
  id,
  title: id,
  values,
});

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

function database(schema: Field[]) {
  const db: Entry = { id: "db", doc: new Y.Doc(), rev: 0, kind: "database" };

  for (const f of schema) fields(db).set(f.id, f);

  return db;
}

const schema = [
  field("note", "text"),
  field("when", "date"),
  field("state", "status"),
  field("kind", "select"),
];
const db = database(schema);

function arrange(view: Partial<View>, rows: Row[] = [], mobile = false) {
  return arrangeRows(db, { ...baseView, ...view }, schema, rows, mobile);
}

describe("arranging rows", () => {
  it("shows the chosen properties in view order and skips deleted ones", () => {
    const arranged = arrange({ visible: ["kind", "deleted", "note"] });

    expect(arranged.shown).toEqual(["kind", "note"]);
    expect(arrange({}).shown).toEqual(["note", "when", "state", "kind"]);
  });

  it("groups boards by the first status or select and calendars by date", () => {
    expect(arrange({ type: "board" }).group).toBe("state");
    expect(arrange({ type: "calendar" }).group).toBe("when");
    expect(arrange({ type: "board", group: "kind" }).group).toBe("kind");
  });

  it("has no group property when nothing fits the layout", () => {
    const plain = [field("note", "text")];
    const arranged = arrangeRows(
      database(plain),
      { ...baseView, type: "board" },
      plain,
      [],
      false,
    );

    expect(arranged.group).toBe("");
    expect(arranged.groupField).toBeUndefined();
  });

  it("groups calendar entries by the first day of a range", () => {
    const rows = [
      row("a", { when: "2026-11-01/2026-11-03" }),
      row("b", { when: "2026-11-01" }),
      row("c"),
    ];
    const arranged = arrange({ type: "calendar" }, rows);

    expect([...arranged.grouped.keys()]).toEqual(["2026-11-01", ""]);
    expect(arranged.grouped.get("2026-11-01")!.map((r) => r.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("puts group headings before their rows in grouped tables", () => {
    const rows = [
      row("a", { kind: "x" }),
      row("b", { kind: "y" }),
      row("c", { kind: "x" }),
    ];
    const { items } = arrange({ group: "kind" }, rows);

    expect(items.map(itemKey)).toEqual(["group:x", "a", "c", "group:y", "b"]);
    expect(arrange({ type: "board", group: "kind" }, rows).items).toBe(rows);
  });

  it("lays out galleries in three columns, or two on phones", () => {
    expect(arrange({ type: "gallery" }).columns).toBe(3);
    expect(arrange({ type: "gallery" }, [], true).columns).toBe(2);
    expect(arrange({ type: "list" }, [], true).columns).toBe(1);
  });

  it("changes the layout key when widths, wrapping or columns change", () => {
    const view = { ...baseView, widths: { note: 120 } };
    const key = layoutKey(view, arrange(view));

    expect(
      layoutKey({ ...view, widths: { note: 121 } }, arrange(view)),
    ).not.toBe(key);
    expect(layoutKey({ ...view, wrap: true }, arrange(view))).not.toBe(key);
    expect(layoutKey(view, arrange(view))).toBe(key);
  });
});

describe("visible window", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row("r" + i));

  it("starts at the first row whose bottom is below the offset", () => {
    const arranged = arrange({}, rows);

    expect(visibleWindow(arranged, new Map(), 0)).toMatchObject({
      start: 0,
      top: 0,
      first: 0,
      total: 10 * ROW_HEIGHT,
    });
    expect(
      visibleWindow(arranged, new Map(), ROW_HEIGHT * 2 + 1),
    ).toMatchObject({ start: 2, top: ROW_HEIGHT * 2 });
    expect(visibleWindow(arranged, new Map(), ROW_HEIGHT * 2)).toMatchObject({
      start: 2,
    });
  });

  it("uses measured heights for rows and group headings", () => {
    const arranged = arrange({ group: "kind" }, [row("a"), row("b")]);
    const heights = new Map([
      ["group:", 50],
      ["a", 100],
    ]);

    expect(visibleWindow(arranged, heights, 149)).toMatchObject({
      start: 1,
      top: 50,
      total: 50 + 100 + ROW_HEIGHT,
    });
  });

  it("stays on the last row when scrolled past the end or before the start", () => {
    const arranged = arrange({}, rows);

    expect(visibleWindow(arranged, new Map(), 1e9).start).toBe(9);
    expect(visibleWindow(arranged, new Map(), -50).start).toBe(0);
    expect(visibleWindow(arrange({}, []), new Map(), 100)).toMatchObject({
      start: 0,
      total: 0,
    });
  });

  it("counts gallery rows of cards and reports the first card", () => {
    const arranged = arrange({ type: "gallery" }, rows);
    const span = visibleWindow(arranged, new Map(), CARD_HEIGHT * 2 + 10);

    expect(span).toMatchObject({
      start: 2,
      first: 6,
      total: 4 * CARD_HEIGHT,
    });
  });
});
