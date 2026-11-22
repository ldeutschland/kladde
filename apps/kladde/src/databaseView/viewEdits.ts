import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { fields, newField, views } from "../database/fields";
import {
  type Field,
  type FieldType,
  type Layout,
  type View,
} from "../database/types";
import { numberRows } from "../database/rules";

export function changeView(db: Entry, active: View, patch: Partial<View>) {
  views(db).set(active.id, { ...active, ...patch });
}

export function updateField(
  book: Notebook,
  db: Entry,
  id: string,
  patch: Partial<Field>,
) {
  const latest = fields(db).get(id);

  if (!latest) return;
  fields(db).set(id, {
    ...latest,
    ...patch,
    options: patch.options ?? latest.options ?? [],
  });
  if (patch.type === "autoId" && latest.type !== "autoId")
    void numberRows(book, db, id);
}

export function renameField(db: Entry, id: string, raw: string) {
  const field = fields(db).get(id);
  const name = raw.trim();

  if (field && name) fields(db).set(id, { ...field, name });
}

function withoutField(view: View, id: string): View {
  return {
    ...view,
    sort: view.sort === id ? "" : view.sort,
    group: view.group === id ? "" : view.group,
    groups: (view.groups ?? []).map((g) => ({
      ...g,
      filters: g.filters.filter((rule) => rule.field !== id),
    })),
    thenSort: (view.thenSort ?? []).filter((key) => key.field !== id),
    summary: view.summary?.field === id ? undefined : view.summary,
    filters: view.filters.filter((rule) => rule.field !== id),
    calcs: Object.fromEntries(
      Object.entries(view.calcs ?? {}).filter(([key]) => key !== id),
    ),
    tints: (view.tints ?? []).map((tint) => ({
      ...tint,
      filters: tint.filters.filter((rule) => rule.field !== id),
    })),
  };
}

export function removeField(db: Entry, tabs: View[], id: string) {
  db.doc.transact(() => {
    fields(db).delete(id);
    for (const v of tabs) views(db).set(v.id, withoutField(v, id));
  });
}

export function addGroupField(db: Entry, t: T, schema: Field[], type: Layout) {
  const wanted: FieldType[] =
    type === "calendar"
      ? ["date"]
      : type === "board"
        ? ["status", "select"]
        : [];

  if (!wanted.length || schema.some((f) => wanted.includes(f.type))) return;
  if (type === "calendar") newField(db, t("date"), "date");
  else
    newField(db, t("status"), "status", [
      t("statusTodo"),
      t("statusDoing"),
      t("statusDone"),
    ]);
}
