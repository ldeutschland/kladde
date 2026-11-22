import type { Field } from "../database/types";
import { AutomationPanel } from "./AutomationPanel";
import { CellEditor, type CellTarget } from "./CellEditor";
import { FieldForm } from "./FieldForm";
import { MenuLayer } from "./MenuLayer";
import { renameRow, storeValue } from "./rowEdits";
import type { DatabaseScope } from "./databaseScope";

export function DatabaseOverlays({ database }: { database: DatabaseScope }) {
  const { book, db, t, editing, bulkEdit } = database;
  const sample = database.result[0];

  return (
    <>
      {editing && <SingleCellEditor database={database} target={editing} />}
      {bulkEdit?.field && (
        <BulkCellEditor
          database={database}
          target={bulkEdit}
          field={bulkEdit.field}
        />
      )}
      <DatabaseMenus database={database} />
      {database.automationOpen && (
        <AutomationPanel
          book={book}
          db={db}
          t={t}
          close={() => database.showAutomations(false)}
        />
      )}
      {database.adding && (
        <FieldForm
          book={book}
          db={db}
          t={t}
          sample={sample}
          scope={database.scope}
          close={() => database.setAdding(false)}
        />
      )}
    </>
  );
}

function SingleCellEditor({
  database,
  target,
}: {
  database: DatabaseScope;
  target: CellTarget;
}) {
  const { store } = database;

  return (
    <CellEditor
      key={target.row.id + (target.field?.id ?? "")}
      target={target}
      book={database.book}
      t={database.t}
      save={(raw) =>
        target.field
          ? storeValue(store, target.row.id, target.field, raw)
          : renameRow(store, target.row.id, raw)
      }
      close={() => database.setEditing(null)}
    />
  );
}

function BulkCellEditor({
  database,
  target,
  field,
}: {
  database: DatabaseScope;
  target: CellTarget;
  field: Field;
}) {
  return (
    <CellEditor
      key={"bulk" + field.id}
      target={target}
      book={database.book}
      t={database.t}
      save={(raw) => database.storeMany(field, raw)}
      close={() => database.setBulkEdit(null)}
    />
  );
}

function DatabaseMenus({ database }: { database: DatabaseScope }) {
  return (
    <MenuLayer
      menu={database.menu}
      context={database.context}
      schema={database.schema}
      shown={database.arranged.shown}
      canDeleteView={database.tabs.length >= 2}
      sample={database.result[0]}
      scope={database.scope}
      actions={database.menuActions}
    />
  );
}
