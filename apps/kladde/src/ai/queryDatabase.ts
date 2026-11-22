import type { Entry } from "../notebook/notebook";
import { fields } from "../database/fields";
import { rowIndex, timedRow } from "../database/rowIndex";
import { selectRows } from "../database/selectRows";
import { type Field, type View } from "../database/types";
import { computeRows } from "../database/compute";
import { sharedRows, sharedScope } from "../database/sharedRows";
import { textArg } from "./toolArguments";
import { viewRules } from "./viewArguments";
import type { ToolRequest } from "./readTools";
import type { AgentRun } from "./AgentRun";

const MAX_ROWS = 100;
const DEFAULT_ROWS = 40;

type IndexedRow = Awaited<ReturnType<typeof rowIndex>>[number];

function draftedRows(
  run: AgentRun,
  databaseId: string,
  stored: IndexedRow[],
  schema: Field[],
) {
  const indexed = new Map(stored.map((row) => [row.id, row]));

  for (const draft of run.changes.values()) {
    const { page } = draft;

    if (page.kind !== "row" || page.parent !== databaseId) continue;

    if (page.archived) {
      indexed.delete(page.id);
      continue;
    }

    indexed.set(
      page.id,
      timedRow(
        page.id,
        page.title,
        draft.copy.doc.getMap<string>("properties").toJSON(),
        page,
        schema,
      ),
    );
  }

  return [...indexed.values()];
}

async function queriedDatabase(run: AgentRun, id: string): Promise<Entry> {
  const db = await run.entry(id, false);

  if (db.kind !== "database") throw Error("Invalid database");

  return db;
}

export async function queryDatabase(run: AgentRun, request: ToolRequest) {
  const { id, args } = request;
  const db = await queriedDatabase(run, id);
  const schema = Array.from(fields(db).values());
  const view: View = {
    id: "",
    name: "",
    type: "table",
    ...viewRules(schema, args),
    group: "",
    visible: null,
    widths: {},
  };
  const stored = await rowIndex(run.book, db);
  const hidden = run.exclusions();
  const rows = draftedRows(run, id, stored, schema);
  const offset = Number(args.offset ?? 0);
  const result = selectRows(
    computeRows(
      sharedRows(rows, schema, hidden),
      schema,
      await sharedScope(run.book, schema, hidden),
    ),
    view,
    textArg(args.query ?? ""),
    schema,
  ).slice(
    offset,
    offset + Math.min(MAX_ROWS, Number(args.limit ?? DEFAULT_ROWS)),
  );

  for (const row of result) run.shared.add(row.id);

  return result;
}
