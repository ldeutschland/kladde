import { ArrowUpRight, Square, SquareCheck } from "lucide-react";
import type { Notebook } from "../notebook/notebook";
import { validValue } from "../database/validValue";
import { type Field, type FieldType, type Row } from "../database/types";
import {
  barRatio,
  calculate,
  displayValue,
  formatNumber,
  isPercent,
  numericField,
  splitList,
  type Calculation,
} from "../database/compute";

const BOOLEAN_TEXT = ["true", "false"];
const RELATION_PREVIEW = 6;

export const choiceTypes: FieldType[] = ["select", "multi", "status"];

export function pageLanguage() {
  return document.documentElement.lang || "de";
}

export function tryValue(field: Field, raw: string, book: Notebook) {
  try {
    return validValue(field, raw, book);
  } catch {
    return null;
  }
}

export function calcText(
  calc: Calculation,
  field: Field | undefined,
  rows: Row[],
  lang: string,
  today: string,
) {
  const values = rows.map((r) =>
    field ? (r.values[field.id] ?? "") : r.title,
  );
  const result = calculate(calc, values);

  if (result === null || result === "") return "—";
  if (isPercent(calc))
    return formatNumber(Number(result), undefined, lang) + " %";
  if (
    typeof result === "number" &&
    field &&
    numericField(field) &&
    !calc.startsWith("count")
  )
    return displayValue(field, String(result), lang, today);
  if (
    typeof result === "string" &&
    field &&
    (calc === "earliest" || calc === "latest")
  )
    return displayValue(field, result, lang, today);

  return typeof result === "number"
    ? formatNumber(result, "thousands", lang)
    : String(result);
}

function CheckMark({ on }: { on: boolean }) {
  return on ? <SquareCheck size={16} /> : <Square size={16} />;
}

function RelationTags({ ids, book }: { ids: string[]; book: Notebook }) {
  return (
    <>
      {ids.slice(0, RELATION_PREVIEW).map((id) => (
        <span className="reltag" key={id}>
          <ArrowUpRight size={12} />
          {book.pages.get(id)?.title || "…"}
        </span>
      ))}
      {ids.length > RELATION_PREVIEW && (
        <span className="count">+{ids.length - RELATION_PREVIEW}</span>
      )}
    </>
  );
}

function TextValue({
  field,
  value,
  today,
}: {
  field: Field;
  value: string;
  today: string;
}) {
  const text = displayValue(field, value, pageLanguage(), today);
  const ratio = barRatio(field, value);

  if (ratio === null) return text;

  return (
    <span className="valuebar">
      <span className="bartrack">
        <span style={{ width: ratio * 100 + "%" }} />
      </span>
      <span>{text}</span>
    </span>
  );
}

export function Cell({
  field,
  row,
  book,
  today,
}: {
  field: Field;
  row: Row;
  book: Notebook;
  today: string;
}) {
  const value = row.values[field.id] ?? "";

  if (field.type === "checkbox") return <CheckMark on={value === "true"} />;
  if (!value) return null;
  if (field.type === "relation")
    return <RelationTags ids={splitList(value)} book={book} />;
  if (choiceTypes.includes(field.type))
    return splitList(value).map((v) => (
      <span className="tag" key={v} data-color={field.options.indexOf(v) % 9}>
        {v}
      </span>
    ));
  if (field.type === "formula" && BOOLEAN_TEXT.includes(value))
    return <CheckMark on={value === "true"} />;

  return <TextValue field={field} value={value} today={today} />;
}
