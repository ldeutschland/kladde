import type { MouseEvent } from "react";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { type Field, type Row, type View } from "../database/types";

export interface ViewContext {
  book: Notebook;
  db: Entry;
  t: T;
  today: string;
  mobile: boolean;
  active: View;
}

type Handler = (e: MouseEvent<HTMLElement>) => void;

export interface RowActions {
  open: (id: string) => void;
  menu: (id: string) => Handler;
  edit: (row: Row, field: Field | null) => Handler;
  toggle: (row: Row, field: Field) => void;
  run: (row: Row, field: Field) => void;
  tint: (row: Row) => number | undefined;
}

export type MenuKind =
  "filter" | "sort" | "view" | "field" | "layout" | "calc" | "bulk";

export type Menu = {
  kind: MenuKind;
  anchor: DOMRect;
  field?: string;
};

export type OpenMenu = (
  kind: MenuKind,
  e: MouseEvent<HTMLElement>,
  field?: string,
) => void;

export type ChangeView = (patch: Partial<View>) => void;
