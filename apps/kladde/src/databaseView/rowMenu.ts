import type { MouseEvent } from "react";
import { AppWindow, ArrowUpRight, Copy, Trash2 } from "lucide-react";
import type { T } from "../locale/locale";
import { showContextMenu, type MenuEntry } from "../ui/ContextMenu";
import { fields } from "../database/fields";
import { rowTint } from "../database/selectRows";
import type { CellTarget } from "./CellEditor";
import { runRowButton, storeValue, type RowStore } from "./rowEdits";
import type { RowActions, ViewContext } from "./types";

export interface RowMenuOptions {
  t: T;
  open: (id: string) => void;
  openTab?: (id: string) => void;
  duplicate: (id: string) => void;
  trash: (id: string) => void;
}

export function rowActionsFor(
  context: ViewContext,
  store: RowStore,
  options: RowMenuOptions & { edit: (target: CellTarget) => void },
): RowActions {
  const { active, db, today } = context;

  return {
    open: options.open,
    menu: (id) => (e) => showContextMenu(e, rowMenuEntries(id, options)),
    edit: (row, field) => (e: MouseEvent<HTMLElement>) =>
      options.edit({
        row,
        field,
        anchor: e.currentTarget.getBoundingClientRect(),
      }),
    toggle: (row, field) =>
      void storeValue(
        store,
        row.id,
        field,
        row.values[field.id] === "true" ? "false" : "true",
      ),
    run: (row, field) => void runRowButton(store, row, field),
    tint: (row) => rowTint(row, active, fields(db), today),
  };
}

function rowMenuEntries(id: string, options: RowMenuOptions) {
  const { t, openTab } = options;
  const entries: MenuEntry[] = [
    { label: t("open"), icon: ArrowUpRight, run: () => options.open(id) },
  ];

  if (openTab)
    entries.push({
      label: t("openInNewTab"),
      icon: AppWindow,
      run: () => openTab(id),
    });
  entries.push(
    { label: t("duplicate"), icon: Copy, run: () => options.duplicate(id) },
    "separator",
    {
      label: t("toTrash"),
      icon: Trash2,
      danger: true,
      run: () => options.trash(id),
    },
  );

  return entries;
}
