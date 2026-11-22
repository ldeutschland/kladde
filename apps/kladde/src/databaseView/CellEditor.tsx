import { useState, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { Popover, listKeys } from "../ui/dialog";
import { ChoiceMenu, type Choice } from "../ui/Select";
import { TextArea } from "../ui/TextArea";
import { type Field, type FieldType, type Row } from "../database/types";
import { splitList } from "../database/compute";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";

export interface CellTarget {
  row: Row;
  field: Field | null;
  anchor: DOMRect;
}

export const inputTypes: Partial<Record<FieldType, string>> = {
  number: "number",
  date: "date",
  url: "url",
  email: "email",
  phone: "tel",
};
const menuTypes: FieldType[] = ["select", "status", "multi", "relation"];

const TITLE_LENGTH = 200;
const VALUE_LENGTH = 8192;
const MENU_WIDTH = 240;
const FIELD_WIDTH = 280;

function relationChoices(book: Notebook, field: Field, t: T): Choice[] {
  return Array.from(book.pages.values())
    .filter((p) => p.parent === field.target && p.kind === "row" && !p.archived)
    .map((p) => ({ value: p.id, label: p.title || t("untitled") }));
}

function optionChoices(field: Field, t: T): Choice[] {
  return [
    { value: "", label: t("emptyValue") },
    ...field.options.map((option) => ({ value: option, label: option })),
  ];
}

function MultiMenu({
  label,
  choices,
  tagged,
  value,
  save,
}: {
  label: string;
  choices: Choice[];
  tagged: boolean;
  value: string;
  save: (raw: string) => void;
}) {
  const [chosen, setChosen] = useState(() => splitList(value));
  const toggle = (option: string) => {
    const next = chosen.includes(option)
      ? chosen.filter((c) => c !== option)
      : [...chosen, option];

    setChosen(next);
    save(next.join(","));
  };

  return (
    <div className="menu" role="menu" aria-label={label} onKeyDown={listKeys}>
      {choices.map((choice, i) => (
        <button
          key={choice.value}
          type="button"
          role="menuitemcheckbox"
          aria-checked={chosen.includes(choice.value)}
          autoFocus={i === 0}
          onClick={() => toggle(choice.value)}
        >
          <span className="grow">
            <span className={tagged ? "tag" : "reltag"} data-color={i % 9}>
              {choice.label}
            </span>
          </span>
          {chosen.includes(choice.value) && <Check />}
        </button>
      ))}
    </div>
  );
}

function TextEditor({
  label,
  value,
  type,
  long,
  limit,
  invalid,
  change,
  submit,
  t,
}: {
  label: string;
  value: string;
  type: string;
  long: boolean;
  limit: number;
  invalid: boolean;
  change: (raw: string) => void;
  submit: () => void;
  t: T;
}) {
  const shared = {
    "aria-label": label,
    "aria-invalid": invalid,
    autoFocus: true,
    maxLength: limit,
    placeholder: t("emptyValue"),
    value,
  };
  const enter = (e: KeyboardEvent<HTMLElement>, newline: boolean) => {
    if (e.key !== "Enter" || newline || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };

  if (long)
    return (
      <TextArea
        {...shared}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => enter(e, e.shiftKey)}
      />
    );

  return (
    <input
      {...shared}
      type={type}
      onChange={(e) => change(e.target.value)}
      onKeyDown={(e) => enter(e, false)}
    />
  );
}

function editorWidth(target: CellTarget) {
  const type = target.field?.type;
  const menu = !!type && menuTypes.includes(type);

  return Math.max(target.anchor.width, menu ? MENU_WIDTH : FIELD_WIDTH);
}

type Save = (raw: string) => Promise<boolean>;

interface CellProps {
  target: CellTarget;
  book: Notebook;
  t: T;
  save: Save;
  close: () => void;
}

function useCellDraft({ target, save, close }: CellProps) {
  const { field, row } = target;
  const initial = field ? (row.values[field.id] ?? "") : row.title;
  const [draft, setDraft] = useState(initial);
  const [problem, setProblem] = useState(false);

  async function commit(raw: string, dismissed = false) {
    if (raw.trim() === initial.trim()) {
      close();

      return;
    }

    const stored = await save(raw);

    if (stored || dismissed) close();
    else setProblem(true);
  }

  function change(raw: string) {
    setProblem(false);
    setDraft(raw);
  }

  return { initial, draft, problem, commit, change };
}

type CellDraft = ReturnType<typeof useCellDraft>;

function TextCell({
  target: { field },
  t,
  cell,
  label,
}: CellProps & { cell: CellDraft; label: string }) {
  const type = field ? (inputTypes[field.type] ?? "text") : "text";
  const range = field?.type === "date" && cell.initial.includes("/");

  return (
    <TextEditor
      label={label}
      value={cell.draft}
      type={range ? "text" : type}
      long={field?.type === "text"}
      limit={field ? VALUE_LENGTH : TITLE_LENGTH}
      invalid={cell.problem}
      change={cell.change}
      submit={() => void cell.commit(cell.draft)}
      t={t}
    />
  );
}

function CellBody(props: CellProps & { cell: CellDraft; label: string }) {
  const { target, book, t, save, cell, label } = props;
  const { field } = target;

  if (field?.type === "select" || field?.type === "status")
    return (
      <ChoiceMenu
        label={label}
        searchLabel={t("search")}
        value={cell.initial}
        choices={optionChoices(field, t)}
        pick={(raw) => void cell.commit(raw)}
      />
    );
  if (field?.type === "relation")
    return (
      <MultiMenu
        label={label}
        choices={relationChoices(book, field, t)}
        tagged={false}
        value={cell.initial}
        save={(raw) => void save(raw)}
      />
    );
  if (field?.type === "multi")
    return (
      <MultiMenu
        label={label}
        choices={field.options.map((option) => ({
          value: option,
          label: option,
        }))}
        tagged
        value={cell.initial}
        save={(raw) => void save(raw)}
      />
    );

  return <TextCell {...props} />;
}

export function CellEditor(props: CellProps) {
  const { target, t, close } = props;
  const { field } = target;
  const cell = useCellDraft(props);
  const label = field ? field.name : t("title");
  const typed = !field || !menuTypes.includes(field.type);

  return (
    <Popover
      anchor={target.anchor}
      label={label}
      close={() => (typed ? void cell.commit(cell.draft, true) : close())}
      width={editorWidth(target)}
      cover
    >
      <div className="celleditor">
        <CellBody {...props} cell={cell} label={label} />
        {cell.problem && (
          <p className="celleditorerror" role="alert">
            {t("invalidValue")}
          </p>
        )}
      </div>
    </Popover>
  );
}
