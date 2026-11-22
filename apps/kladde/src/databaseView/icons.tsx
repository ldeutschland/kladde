import {
  AlignLeft,
  ArrowUpRight,
  AtSign,
  Calendar,
  CalendarDays,
  CircleChevronDown,
  CircleDot,
  Clock,
  Columns3,
  Fingerprint,
  Hash,
  History,
  Layers,
  LayoutGrid,
  Link,
  List,
  MousePointerClick,
  Phone,
  Rows3,
  Sigma,
  SquareCheck,
  Table2,
  User,
  type LucideIcon,
} from "lucide-react";
import { type Field, type FieldType, type Layout } from "../database/types";

export const typeIcons: Record<FieldType, LucideIcon> = {
  text: AlignLeft,
  number: Hash,
  select: CircleChevronDown,
  multi: List,
  status: CircleDot,
  date: Calendar,
  checkbox: SquareCheck,
  url: Link,
  email: AtSign,
  phone: Phone,
  person: User,
  relation: ArrowUpRight,
  created: Clock,
  edited: History,
  formula: Sigma,
  rollup: Layers,
  autoId: Fingerprint,
  button: MousePointerClick,
};

export const layoutIcons: Record<Layout, LucideIcon> = {
  table: Table2,
  board: Columns3,
  list: Rows3,
  gallery: LayoutGrid,
  calendar: CalendarDays,
};

export function FieldIcon({ field }: { field: Field }) {
  const Icon = typeIcons[field.type];

  return <Icon size={16} />;
}
