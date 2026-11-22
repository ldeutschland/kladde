import { type Notebook } from "../notebook/notebook";
import Papa from "papaparse";
import { type Field, type Row } from "./types";
import { addView, newField, validFieldName } from "./fields";

const FORMULA_START = /^[=+\-@\t\r]/;

export function csv(rows: Row[], schema: Field[]) {
  return Papa.unparse(
    [
      ["Title", ...schema.map((f) => f.name)],
      ...rows.map((r) => [r.title, ...schema.map((f) => r.values[f.id] ?? "")]),
    ],
    { escapeFormulae: FORMULA_START },
  );
}
export async function importCsv(
  book: Notebook,
  name: string,
  text: string,
  parent: string | null = null,
) {
  if (text.length > 8_000_000) throw Error("CSV too large");
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  const [header, ...rows] = parsed.data;

  if (
    parsed.errors.length ||
    !header ||
    header.length > 101 ||
    rows.length > 10000 ||
    rows.some((r) => r.length !== header.length) ||
    !header.slice(1).every(validFieldName)
  )
    throw Error("Invalid CSV");
  const db = book.add(name, "database", parent);
  const cols = header.slice(1).map((n) => newField(db, n, "text"));

  addView(db, "Table", "table");

  for (const [index, line] of rows.entries()) {
    const e = book.add(line[0], "row", db.id);

    db.doc.getArray<string>("row_order").push([e.id]);
    for (const [i, col] of cols.entries())
      e.doc.getMap("properties").set(col, line[i + 1]);
    if (index % 100 === 99) await book.flush();
  }

  await book.flush();

  return db;
}
