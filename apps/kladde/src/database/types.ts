import type { Calculation } from "./compute";

export const types = [
  "text",
  "number",
  "select",
  "multi",
  "status",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "person",
  "relation",
  "created",
  "edited",
  "formula",
  "rollup",
  "autoId",
  "button",
] as const;
export type FieldType = (typeof types)[number];
export const readOnlyTypes: FieldType[] = [
  "created",
  "edited",
  "formula",
  "rollup",
  "autoId",
  "button",
];
export const numberFormats = [
  "plain",
  "integer",
  "decimal",
  "thousands",
  "percent",
  "euro",
  "dollar",
  "pound",
  "franc",
  "yen",
] as const;
export type NumberFormat = (typeof numberFormats)[number];
export const dateFormats = [
  "iso",
  "short",
  "medium",
  "long",
  "weekday",
  "relative",
] as const;
export type DateFormat = (typeof dateFormats)[number];
export interface Field {
  id: string;
  name: string;
  type: FieldType;
  options: string[];
  target?: string;
  format?: NumberFormat;
  bar?: boolean;
  barMax?: number;
  dateFormat?: DateFormat;
  formula?: string;
  relation?: string;
  property?: string;
  rollup?: Calculation;
  prefix?: string;
  rule?: string;
}
export interface Tint {
  filters: Rule[];
  match: "all" | "any";
  color: number;
}
export const layouts = [
  "table",
  "board",
  "list",
  "gallery",
  "calendar",
] as const;
export type Layout = (typeof layouts)[number];
export interface Rule {
  op?: string;
  end?: string;
  field: string;
  value: string;
}
export interface View {
  id: string;
  name: string;
  type: Layout;
  filters: Rule[];
  match: "all" | "any";
  sort: string;
  descending: boolean;
  group: string;
  visible: string[] | null;
  widths: Record<string, number>;
  wrap?: boolean;
  groups?: { filters: Rule[]; match: "all" | "any" }[];
  thenSort?: SortKey[];
  summary?: {
    field: string;
    calculation: "count" | "sum" | "average" | "minimum" | "maximum";
  };
  groupMatch?: "all" | "any";
  calcs?: Record<string, Calculation>;
  tints?: Tint[];
}
export interface Row {
  id: string;
  title: string;
  values: Record<string, string>;
  created?: number;
  edited?: number;
}
export type SortKey = { field: string; descending: boolean };
