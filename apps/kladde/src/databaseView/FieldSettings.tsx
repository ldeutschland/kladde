import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T, Word } from "../locale/locale";
import { Select } from "../ui/Select";
import {
  dateFormats,
  numberFormats,
  types,
  type Field,
  type FieldType,
  type Row,
} from "../database/types";
import { fields } from "../database/fields";
import {
  numericField,
  rollupCalculations,
  type ComputeScope,
} from "../database/compute";
import { automations } from "../database/rules";
import { FormulaEditor } from "./FormulaEditor";

const OPTION_LENGTH = 200;
const OPTION_LIMIT = 100;
const PREFIX_PATTERN = /[^A-Za-z0-9]/g;
const PREFIX_LENGTH = 10;
const BAR_LIMIT = 1e12;
const choiceTypes: FieldType[] = ["select", "multi", "status"];
const dateTypes: FieldType[] = ["date", "created", "edited"];

export interface FieldSettingsProps {
  field: Field;
  update: (patch: Partial<Field>) => void;
  book: Notebook;
  db: Entry;
  sample?: Row;
  scope: ComputeScope;
  t: T;
  renameOption?: (from: string, to: string) => void;
  editType?: boolean;
  editOptions?: boolean;
  live?: boolean;
}

function OptionsEditor({
  field,
  update,
  renameOption,
  t,
}: Pick<FieldSettingsProps, "field" | "update" | "renameOption" | "t">) {
  const [draft, setDraft] = useState("");
  const options = field.options ?? [];
  const add = () => {
    const name = draft.trim().replace(/,/g, " ").slice(0, OPTION_LENGTH);

    if (!name || options.includes(name) || options.length >= OPTION_LIMIT)
      return;
    update({ options: [...options, name] });
    setDraft("");
  };
  const rename = (index: number, raw: string) => {
    const name = raw.trim().replace(/,/g, " ").slice(0, OPTION_LENGTH);
    const old = options[index];

    if (!name || name === old || options.includes(name)) return;
    update({ options: options.map((o, i) => (i === index ? name : o)) });
    renameOption?.(old, name);
  };

  return (
    <div className="optioneditor">
      <h4>{t("options").split(",")[0]}</h4>
      {options.map((option, i) => (
        <div className="optionline" key={option}>
          <span className="tag swatch" data-color={i % 9} />
          <input
            aria-label={t("name")}
            defaultValue={option}
            maxLength={OPTION_LENGTH}
            onBlur={(e) => rename(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <button
            type="button"
            aria-label={t("remove") + ": " + option}
            onClick={() =>
              update({ options: options.filter((o) => o !== option) })
            }
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="optionline">
        <Plus size={14} />
        <input
          aria-label={t("addOption")}
          placeholder={t("optionName")}
          value={draft}
          maxLength={OPTION_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            add();
          }}
          onBlur={add}
        />
      </div>
    </div>
  );
}

function NumberDisplay({
  field,
  update,
  t,
}: Pick<FieldSettingsProps, "field" | "update" | "t">) {
  return (
    <>
      <label className="menurow">
        <span className="grow">{t("numberFormat")}</span>
        <Select
          label={t("numberFormat")}
          value={field.format ?? "plain"}
          choices={numberFormats.map((value) => ({
            value,
            label: t(("fmt_" + value) as Word),
          }))}
          change={(format) => update({ format: format as Field["format"] })}
        />
      </label>
      <button
        type="button"
        className="switchitem"
        aria-pressed={!!field.bar}
        onClick={() => update({ bar: !field.bar })}
      >
        <span className="grow">{t("showAsBar")}</span>
        <span className="switch" />
      </button>
      {field.bar && (
        <label className="menurow">
          <span className="grow">{t("barMax")}</span>
          <input
            type="number"
            className="narrow"
            aria-label={t("barMax")}
            defaultValue={
              field.barMax ?? (field.format === "percent" ? 1 : 100)
            }
            onBlur={(e) => {
              const max = Number(e.target.value);

              if (Number.isFinite(max) && max > 0 && max < BAR_LIMIT)
                update({ barMax: max });
            }}
          />
        </label>
      )}
    </>
  );
}

function DateDisplay({
  field,
  update,
  t,
}: Pick<FieldSettingsProps, "field" | "update" | "t">) {
  return (
    <label className="menurow">
      <span className="grow">{t("dateFormat")}</span>
      <Select
        label={t("dateFormat")}
        value={field.dateFormat ?? (field.type === "date" ? "iso" : "medium")}
        choices={dateFormats.map((value) => ({
          value,
          label: t(("dfmt_" + value) as Word),
        }))}
        change={(dateFormat) =>
          update({ dateFormat: dateFormat as Field["dateFormat"] })
        }
      />
    </label>
  );
}

function RollupSettings({
  field,
  update,
  book,
  db,
  t,
}: Pick<FieldSettingsProps, "field" | "update" | "book" | "db" | "t">) {
  const [targetSchema, setTargetSchema] = useState<Field[] | null>(null);
  const relations = Array.from(fields(db).values()).filter(
    (f) => f.type === "relation" && f.target,
  );
  const relation = relations.find((f) => f.id === field.relation);
  const target = relation?.target ?? "";

  useEffect(() => {
    if (!target) return;
    let live = true;

    void book.load(target).then((entry) => {
      if (live) setTargetSchema(Array.from(fields(entry).values()));
    });

    return () => {
      live = false;
    };
  }, [book, target]);
  if (!relations.length)
    return <p className="menuhint">{t("needsRelation")}</p>;
  const property = targetSchema?.find((f) => f.id === field.property);

  return (
    <section className="rollupsettings">
      <label className="menurow">
        <span className="grow">{t("rollupRelation")}</span>
        <Select
          label={t("rollupRelation")}
          value={field.relation ?? ""}
          choices={relations.map((f) => ({ value: f.id, label: f.name }))}
          change={(id) => update({ relation: id, property: "" })}
        />
      </label>
      {relation && targetSchema && (
        <label className="menurow">
          <span className="grow">{t("rollupProperty")}</span>
          <Select
            label={t("rollupProperty")}
            value={field.property ?? ""}
            choices={[
              { value: "", label: t("title") },
              ...targetSchema
                .filter((f) => f.type !== "rollup" && f.type !== "button")
                .map((f) => ({ value: f.id, label: f.name })),
            ]}
            change={(id) => update({ property: id })}
          />
        </label>
      )}
      {relation && (
        <label className="menurow">
          <span className="grow">{t("rollupCalc")}</span>
          <Select
            label={t("rollupCalc")}
            value={field.rollup ?? "showValues"}
            choices={rollupCalculations(property?.type).map((value) => ({
              value,
              label: t(value as Word),
            }))}
            change={(calc) => update({ rollup: calc as Field["rollup"] })}
          />
        </label>
      )}
    </section>
  );
}

function ButtonSettings({
  field,
  update,
  db,
  t,
}: Pick<FieldSettingsProps, "field" | "update" | "db" | "t">) {
  const manual = Array.from(automations(db).values()).filter(
    (rule) => rule?.trigger === "manual",
  );

  if (!manual.length) return <p className="menuhint">{t("buttonNeedsRule")}</p>;

  return (
    <label className="menurow">
      <span className="grow">{t("buttonRule")}</span>
      <Select
        label={t("buttonRule")}
        value={field.rule ?? ""}
        choices={[
          { value: "", label: t("none") },
          ...manual.map((rule) => ({ value: rule.id, label: rule.name })),
        ]}
        change={(rule) => update({ rule })}
      />
    </label>
  );
}

export function FieldSettings(props: FieldSettingsProps) {
  const { field, update, t } = props;
  const showsNumber = numericField(field) && field.type !== "autoId";

  return (
    <div className="fieldsettings">
      {props.editType && (
        <label className="menurow">
          <span className="grow">{t("type")}</span>
          <Select
            label={t("type")}
            value={field.type}
            choices={types.map((value) => ({ value, label: t(value) }))}
            change={(type) => update({ type: type as FieldType })}
          />
        </label>
      )}
      {props.editType && field.type === "relation" && (
        <label className="menurow">
          <span className="grow">{t("relationTo")}</span>
          <Select
            label={t("relationTo")}
            searchLabel={t("search")}
            value={field.target ?? ""}
            choices={Array.from(props.book.pages.values())
              .filter((p) => p.kind === "database" && !p.archived)
              .map((p) => ({ value: p.id, label: p.title || t("untitled") }))}
            change={(target) => update({ target })}
          />
        </label>
      )}
      {props.editOptions && choiceTypes.includes(field.type) && (
        <OptionsEditor {...props} />
      )}
      {field.type === "formula" && <FormulaEditor key={field.id} {...props} />}
      {field.type === "rollup" && <RollupSettings {...props} />}
      {field.type === "button" && <ButtonSettings {...props} />}
      {field.type === "autoId" && (
        <label className="menurow">
          <span className="grow">{t("idPrefix")}</span>
          <input
            className="narrow"
            aria-label={t("idPrefix")}
            defaultValue={field.prefix ?? ""}
            maxLength={PREFIX_LENGTH}
            onChange={(e) =>
              update({
                prefix: e.target.value
                  .replace(PREFIX_PATTERN, "")
                  .slice(0, PREFIX_LENGTH)
                  .toUpperCase(),
              })
            }
          />
        </label>
      )}
      {showsNumber && <NumberDisplay {...props} />}
      {(dateTypes.includes(field.type) || field.type === "rollup") && (
        <DateDisplay {...props} />
      )}
    </div>
  );
}
