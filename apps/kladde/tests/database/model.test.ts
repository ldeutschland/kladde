import { describe, it, expect } from "vitest";
import { mayMove, freshPage, treeParent } from "../../src/notebook/notebook";
import { selectRows } from "../../src/database/selectRows";
import { validValue } from "../../src/database/validValue";
import { csv } from "../../src/database/csv";
import { type View } from "../../src/database/types";

const view: View = {
  id: "a",
  name: "a",
  type: "table",
  filters: [],
  match: "all",
  sort: "number",
  descending: true,
  group: "",
  visible: [],
  widths: {},
};

describe("Notebook integrity", () => {
  it("rejects cycles, absent parents and archived destinations", () => {
    const a = freshPage("a", "a", "page", null),
      b = freshPage("b", "b", "page", "a");
    const pages = new Map([
      ["a", a],
      ["b", b],
    ]);

    expect(mayMove(pages, "a", "b")).toBe(false);
    expect(mayMove(pages, "c", "x")).toBe(false);
    b.archived = 1;
    expect(mayMove(pages, "c", "b")).toBe(false);
    expect(mayMove(pages, "b", null)).toBe(true);
  });
  it("shows pages with a missing, trashed or cyclic parent at the top", () => {
    const pages = new Map(
      ["a", "b", "c", "d", "e", "f"].map((id) => [
        id,
        freshPage(id, id, "page", null),
      ]),
    );
    const at = (id: string) => pages.get(id)!;

    at("a").parent = "gone";
    at("b").archived = 5;
    at("c").parent = "b";
    at("d").parent = "e";
    at("e").parent = "d";
    at("f").parent = "a";
    expect(treeParent(pages, at("a"))).toBeNull();
    expect(treeParent(pages, at("c"))).toBeNull();
    expect(treeParent(pages, at("d"))).toBeNull();
    expect(treeParent(pages, at("e"))).toBe("d");
    expect(treeParent(pages, at("f"))).toBe("a");
    expect(mayMove(pages, "f", "a")).toBe(true);
    expect(mayMove(pages, "f", "gone")).toBe(false);
    expect(mayMove(pages, "f", "b")).toBe(false);
  });
  it("sorts 5000 records numerically and filters AND/OR", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: String(i),
      title: "Firma " + i,
      values: { number: String(i), status: i % 2 ? "Offen" : "Zu" },
    }));
    const fields = [
      { id: "number", name: "n", type: "number" as const, options: [] },
    ];
    const selected = selectRows(
      rows,
      {
        ...view,
        filters: [
          { field: "status", value: "Offen" },
          { field: "", value: "Firma 49" },
        ],
      },
      "",
      fields,
    );

    expect(selected[0].id).toBe("4999");
    expect(selected.every((r) => r.values.status === "Offen")).toBe(true);
    expect(
      selectRows(
        rows,
        {
          ...view,
          match: "any",
          filters: [
            { field: "status", value: "Offen" },
            { field: "status", value: "Zu" },
          ],
        },
        "",
        fields,
      ),
    ).toHaveLength(5000);
  });
  it("escapes spreadsheet formula injection and rejects executable URLs", () => {
    expect(csv([{ id: "a", title: "=SUM(A1)", values: {} }], [])).toContain(
      "'=SUM",
    );
    expect(() =>
      validValue(
        { id: "u", name: "link", type: "url", options: [] },
        "javascript:alert(1)",
        {} as never,
      ),
    ).toThrow();
  });
});
