import { useEffect, useState } from "react";
import { ArrowUpRight, Play, X } from "lucide-react";
import {
  createdAt,
  type Entry,
  type Notebook,
  type Page,
} from "../notebook/notebook";
import type { T } from "../locale/locale";
import { TextArea } from "../ui/TextArea";
import { Select } from "../ui/Select";
import { inputTypes } from "./CellEditor";
import { localDate } from "../database/rules";
import { fields } from "../database/fields";
import { rowScope } from "../database/computedRows";
import { timedRow } from "../database/rowIndex";
import { type Field, type FieldType, type Row } from "../database/types";
import { computeRows, splitList } from "../database/compute";
import { Cell, pageLanguage, tryValue } from "./Cell";
import { FieldIcon } from "./icons";
import { runRule } from "./rowEdits";

const computedTypes: FieldType[] = ["formula", "rollup", "autoId", "button"];
const TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "short",
};

function useComputedRow(book: Notebook, db: Entry, entry: Entry) {
  const [computed, setComputed] = useState<Row | null>(null);

  useEffect(() => {
    let live = true;

    void rowScope(book, db).then((scope) => {
      const current = book.dated(entry.id);
      const list = Array.from(fields(db).values());
      const row = timedRow(
        entry.id,
        current?.title ?? "",
        entry.doc.getMap<string>("properties").toJSON(),
        current,
        list,
      );

      if (live) setComputed(computeRows([row], list, scope)[0]);
    });

    return () => {
      live = false;
    };
  }, [book, db, entry, book.tick]);

  return computed;
}

function ComputedValue({
  field,
  computed,
  book,
  today,
  t,
  run,
}: {
  field: Field;
  computed: Row | null;
  book: Notebook;
  today: string;
  t: T;
  run: () => void;
}) {
  if (field.type === "button")
    return (
      <button
        className="cellbutton"
        disabled={!field.rule}
        title={field.rule ? undefined : t("buttonNeedsRule")}
        onClick={run}
      >
        <Play size={12} />
        {field.name}
      </button>
    );

  return (
    <span className="computedvalue">
      {computed && (
        <Cell field={field} row={computed} book={book} today={today} />
      )}
    </span>
  );
}

export function Properties({
  book,
  entry,
  db,
  t,
}: {
  book: Notebook;
  entry: Entry;
  db: Entry;
  t: T;
}) {
  const [invalid, setInvalid] = useState("");
  const computed = useComputedRow(book, db, entry);
  const [today] = useState(localDate);
  const props = entry.doc.getMap<string>("properties");
  const page = book.pages.get(entry.id);
  const schema = Array.from(fields(db).values());

  if (!schema.length) return null;

  const save = (field: Field, raw: string) => {
    const value = tryValue(field, raw.trim(), book);

    if (value === null) {
      setInvalid(field.id);

      return;
    }

    setInvalid("");
    if (value !== (props.get(field.id) ?? "")) props.set(field.id, value);
  };

  return (
    <div className="properties">
      {schema.map((field) => (
        <div className="property" key={field.id}>
          <span className="propname">
            <FieldIcon field={field} />
            <span>{field.name}</span>
          </span>
          {computedTypes.includes(field.type) ? (
            <ComputedValue
              field={field}
              computed={computed}
              book={book}
              today={today}
              t={t}
              run={() =>
                void runRule(book, db, entry, page?.title ?? "", field)
              }
            />
          ) : (
            <PropertyValue
              key={entry.id + field.id}
              field={field}
              value={props.get(field.id) ?? ""}
              page={page}
              book={book}
              t={t}
              invalid={invalid === field.id}
              save={(raw) => save(field, raw)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

interface ValueProps {
  field: Field;
  value: string;
  book: Notebook;
  t: T;
  invalid: boolean;
  save: (raw: string) => void;
}

function TimestampValue({
  field,
  page,
  book,
}: {
  field: Field;
  page: Page | undefined;
  book: Notebook;
}) {
  if (!page) return null;
  const time = field.type === "created" ? createdAt(page) : book.editedAt(page);

  return (
    <time dateTime={new Date(time).toISOString()}>
      {new Date(time).toLocaleString(pageLanguage(), TIMESTAMP_FORMAT)}
    </time>
  );
}

function MultiValue({ field, value, save }: ValueProps) {
  const chosen = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const toggle = (option: string) => {
    if (chosen.includes(option))
      save(chosen.filter((c) => c !== option).join(","));
    else save([...chosen, option].join(","));
  };

  return (
    <div className="chips">
      {field.options.map((option, i) => (
        <button
          type="button"
          className="tag"
          key={option}
          data-color={i % 9}
          aria-pressed={chosen.includes(option)}
          onClick={() => toggle(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function relationTargets(book: Notebook, field: Field, linked: string[]) {
  return Array.from(book.pages.values()).filter(
    (p) =>
      p.parent === field.target &&
      p.kind === "row" &&
      !p.archived &&
      !linked.includes(p.id),
  );
}

function RelationValue({ field, value, book, t, save }: ValueProps) {
  const linked = splitList(value);
  const targets = relationTargets(book, field, linked);

  return (
    <div className="chips">
      {linked.map((id) => (
        <span className="reltag" key={id}>
          <ArrowUpRight size={12} />
          {book.pages.get(id)?.title || t("untitled")}
          <button
            aria-label={t("remove")}
            onClick={() => save(linked.filter((x) => x !== id).join(","))}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <Select
        label={field.name}
        searchLabel={t("search")}
        value=""
        choices={[
          { value: "", label: linked.length ? "+" : t("emptyValue") },
          ...targets.map((p) => ({
            value: p.id,
            label: p.title || t("untitled"),
          })),
        ]}
        change={(id) => {
          if (id) save([...linked, id].join(","));
        }}
      />
    </div>
  );
}

function ChoiceValue({ field, value, t, save }: ValueProps) {
  return (
    <Select
      label={field.name}
      searchLabel={t("search")}
      value={value}
      choices={[
        { value: "", label: t("emptyValue") },
        ...field.options.map((option) => ({ value: option, label: option })),
      ]}
      change={save}
    />
  );
}

function LongTextValue({ field, value, t, invalid, save }: ValueProps) {
  return (
    <TextArea
      aria-label={field.name}
      defaultValue={value}
      placeholder={t("emptyValue")}
      aria-invalid={invalid}
      maxLength={8192}
      onBlur={(e) => save(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing)
          return;
        e.preventDefault();
        e.currentTarget.blur();
      }}
    />
  );
}

function InputValue({ field, value, t, invalid, save }: ValueProps) {
  let type = inputTypes[field.type] ?? "text";

  if (field.type === "date" && value.includes("/")) type = "text";

  return (
    <input
      aria-label={field.name}
      type={type}
      defaultValue={value}
      placeholder={t("emptyValue")}
      aria-invalid={invalid}
      maxLength={8192}
      onBlur={(e) => save(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

function PropertyValue(props: ValueProps & { page: Page | undefined }) {
  const { field, value, save } = props;

  if (field.type === "created" || field.type === "edited")
    return <TimestampValue field={field} page={props.page} book={props.book} />;
  if (field.type === "checkbox")
    return (
      <input
        type="checkbox"
        aria-label={field.name}
        checked={value === "true"}
        onChange={(e) => save(String(e.target.checked))}
      />
    );
  if (field.type === "multi") return <MultiValue {...props} />;
  if (field.type === "relation") return <RelationValue {...props} />;
  if (field.type === "select" || field.type === "status")
    return <ChoiceValue {...props} />;
  if (field.type === "text") return <LongTextValue {...props} />;

  return <InputValue {...props} />;
}
