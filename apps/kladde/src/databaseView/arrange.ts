import type { Entry } from "../notebook/notebook";
import { fields } from "../database/fields";
import { type Field, type Row, type View } from "../database/types";

const ROW_HEIGHT = 36;
const CARD_HEIGHT = 180;

export type Item = Row | string;

export function itemKey(item: Item) {
  return typeof item === "string" ? "group:" + item : item.id;
}

function visibleFields(db: Entry, active: View, schema: Field[]) {
  if (!active.visible) return schema;

  return active.visible
    .map((id) => fields(db).get(id))
    .filter((f): f is Field => !!f);
}

function groupFieldId(active: View, schema: Field[]) {
  if (active.group) return active.group;

  return (
    schema.find((f) =>
      active.type === "calendar"
        ? f.type === "date"
        : f.type === "status" || f.type === "select",
    )?.id || ""
  );
}

function listsGroups(active: View) {
  return (
    active.type !== "gallery" &&
    !!active.group &&
    active.type !== "board" &&
    active.type !== "calendar"
  );
}

export function arrangeRows(
  db: Entry,
  active: View,
  schema: Field[],
  result: Row[],
  mobile: boolean,
) {
  const visible = visibleFields(db, active, schema);
  const group = groupFieldId(active, schema);
  const grouped = Map.groupBy(result, (r) => {
    const value = r.values[group] ?? "";

    return active.type === "calendar" ? value.split("/")[0] : value;
  });
  const gallery = active.type === "gallery";
  const columns = gallery ? (mobile ? 2 : 3) : 1;
  const items: Item[] = listsGroups(active)
    ? Array.from(grouped, ([k, rows]) => [k, ...rows]).flat()
    : result;

  return {
    visible,
    shown: visible.map((f) => f.id),
    group,
    groupField: fields(db).get(group),
    grouped,
    gallery,
    columns,
    items,
  };
}

export type Arranged = ReturnType<typeof arrangeRows>;

export function layoutKey(active: View, arranged: Arranged) {
  return [
    active.id,
    active.type,
    !!active.wrap,
    arranged.shown.join(","),
    JSON.stringify(active.widths),
    arranged.columns,
  ].join("|");
}

function rowWindow(sizes: number[], offset: number) {
  let start = 0;
  let top = 0;

  while (start < sizes.length - 1 && top + sizes[start] <= offset) {
    top += sizes[start];
    start++;
  }

  const total = sizes.reduce((sum, size) => sum + size, 0);

  return { start, top, total };
}

export function visibleWindow(
  arranged: Arranged,
  heights: Map<string, number>,
  offset: number,
) {
  const { gallery, columns, items } = arranged;
  const sizes = gallery
    ? Array.from(
        { length: Math.ceil(items.length / columns) },
        () => CARD_HEIGHT,
      )
    : items.map((item) => heights.get(itemKey(item)) ?? ROW_HEIGHT);
  const span = rowWindow(sizes, offset);

  return { ...span, first: span.start * columns };
}

export type RowSpan = ReturnType<typeof visibleWindow>;
