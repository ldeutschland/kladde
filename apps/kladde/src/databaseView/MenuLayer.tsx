import { type Field, type Layout, type Row } from "../database/types";
import type { ComputeScope } from "../database/compute";
import {
  BulkMenu,
  CalcMenu,
  FieldMenu,
  FilterMenu,
  LayoutMenu,
  SortMenu,
  type FieldMenuActions,
} from "./menus";
import { ViewMenu, type ViewMenuActions } from "./ViewMenu";
import type { ChangeView, Menu, ViewContext } from "./types";

export interface MenuActions {
  close: () => void;
  change: ChangeView;
  storeMany: (field: Field, value: string) => void;
  bulkEdit: (field: Field, anchor: DOMRect) => void;
  addView: (type: Layout) => void;
  view: ViewMenuActions;
  field: (field: Field) => FieldMenuActions;
}

export function MenuLayer({
  menu,
  context,
  schema,
  shown,
  canDeleteView,
  sample,
  scope,
  actions,
}: {
  menu: Menu | null;
  context: ViewContext;
  schema: Field[];
  shown: string[];
  canDeleteView: boolean;
  sample: Row | undefined;
  scope: ComputeScope;
  actions: MenuActions;
}) {
  if (!menu) return null;
  const { change } = actions;
  const base = { anchor: menu.anchor, context, close: actions.close };
  const field = menu.field
    ? schema.find((f) => f.id === menu.field)
    : undefined;

  if (menu.kind === "calc")
    return <CalcMenu {...base} field={menu.field ?? ""} change={change} />;
  if (menu.kind === "bulk")
    return (
      <BulkMenu
        {...base}
        schema={schema}
        store={actions.storeMany}
        edit={actions.bulkEdit}
      />
    );
  if (menu.kind === "filter")
    return <FilterMenu {...base} schema={schema} change={change} />;
  if (menu.kind === "sort")
    return <SortMenu {...base} schema={schema} change={change} />;
  if (menu.kind === "layout")
    return <LayoutMenu {...base} add={actions.addView} />;
  if (menu.kind === "view")
    return (
      <ViewMenu
        {...base}
        schema={schema}
        shown={shown}
        canDelete={canDeleteView}
        change={change}
        actions={actions.view}
      />
    );
  if (!field) return null;

  return (
    <FieldMenu
      {...base}
      field={field}
      sample={sample}
      scope={scope}
      change={change}
      actions={actions.field(field)}
    />
  );
}
