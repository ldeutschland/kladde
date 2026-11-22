import { useState } from "react";
import type { Entry, Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { Panel } from "../ui/dialog";
import { Select } from "../ui/Select";
import { FieldSettings } from "./FieldSettings";
import { numberRows } from "../database/rules";
import { newField } from "../database/fields";
import { types, type Field, type FieldType, type Row } from "../database/types";
import type { ComputeScope } from "../database/compute";
import { choiceTypes } from "./Cell";
import { typeIcons } from "./icons";

const configKeys = [
  "format",
  "bar",
  "barMax",
  "dateFormat",
  "formula",
  "relation",
  "property",
  "rollup",
  "prefix",
  "rule",
] as const;

function fieldExtras(draft: Partial<Field>) {
  const extra: Partial<Field> = {};

  for (const key of configKeys)
    if (draft[key] !== undefined) Object.assign(extra, { [key]: draft[key] });

  return extra;
}

const MAX_OPTIONS = 100;
const OPTION_LENGTH = 200;

interface Draft {
  kind: FieldType;
  target: string;
  config: Partial<Field>;
}

function formOptions(data: FormData) {
  return String(data.get("options") ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o && o.length <= OPTION_LENGTH);
}

function addField(book: Notebook, db: Entry, data: FormData, draft: Draft) {
  const { kind, target } = draft;

  if (kind === "relation" && book.pages.get(target)?.kind !== "database")
    return false;

  try {
    const id = newField(
      db,
      String(data.get("name") ?? "").trim(),
      kind,
      [...new Set(formOptions(data))].slice(0, MAX_OPTIONS),
      kind === "relation" ? target : undefined,
      fieldExtras(draft.config),
    );

    if (kind === "autoId") void numberRows(book, db, id);

    return true;
  } catch {
    return false;
  }
}

function TypeGrid({
  kind,
  setKind,
  t,
}: {
  kind: FieldType;
  setKind: (kind: FieldType) => void;
  t: T;
}) {
  return (
    <fieldset className="typegrid">
      <legend>{t("type")}</legend>
      {types.map((type) => {
        const Icon = typeIcons[type];

        return (
          <label key={type}>
            <input
              type="radio"
              name="type"
              value={type}
              checked={kind === type}
              onChange={() => setKind(type)}
            />
            <Icon size={16} />
            {t(type)}
          </label>
        );
      })}
    </fieldset>
  );
}

function RelationTarget({
  databases,
  target,
  setTarget,
  t,
}: {
  databases: Page[];
  target: string;
  setTarget: (target: string) => void;
  t: T;
}) {
  return (
    <label className="menurow">
      <span className="grow">{t("relationTo")}</span>
      <Select
        label={t("relationTo")}
        searchLabel={t("search")}
        value={target}
        choices={databases.map((p) => ({
          value: p.id,
          label: p.title || t("untitled"),
        }))}
        change={setTarget}
      />
    </label>
  );
}

export function FieldForm({
  book,
  db,
  t,
  sample,
  scope,
  close,
}: {
  book: Notebook;
  db: Entry;
  t: T;
  sample?: Row;
  scope: ComputeScope;
  close: () => void;
}) {
  const [kind, setKind] = useState<FieldType>("text");
  const [failed, setFailed] = useState(false);
  const [config, setConfig] = useState<Partial<Field>>({});
  const draftField: Field = {
    id: "",
    name: "",
    type: kind,
    options: [],
    ...config,
  };
  const databases = Array.from(book.pages.values()).filter(
    (p) => p.kind === "database" && !p.archived,
  );
  const [target, setTarget] = useState(databases[0]?.id ?? "");

  return (
    <Panel title={t("newProperty")} t={t} close={close} className="fieldpanel">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);

          if (addField(book, db, data, { kind, target, config })) close();
          else setFailed(true);
        }}
      >
        <input
          name="name"
          aria-label={t("name")}
          placeholder={t("name")}
          autoComplete="off"
          required
          maxLength={200}
          autoFocus
        />
        <TypeGrid kind={kind} setKind={setKind} t={t} />
        {choiceTypes.includes(kind) && (
          <input
            name="options"
            aria-label={t("options")}
            placeholder={t("options")}
            autoComplete="off"
            required
            maxLength={4096}
          />
        )}
        {kind === "relation" && (
          <RelationTarget
            databases={databases}
            target={target}
            setTarget={setTarget}
            t={t}
          />
        )}
        <FieldSettings
          field={draftField}
          update={(patch) => setConfig((current) => ({ ...current, ...patch }))}
          book={book}
          db={db}
          sample={sample}
          scope={scope}
          t={t}
          live
        />
        {failed && (
          <p className="error" role="alert">
            {t("invalidValue")}
          </p>
        )}
        <footer>
          <button type="button" onClick={close}>
            {t("cancel")}
          </button>
          <button className="primary">{t("add")}</button>
        </footer>
      </form>
    </Panel>
  );
}
