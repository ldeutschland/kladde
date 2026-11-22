import type { ReactNode } from "react";
import { EyeOff, Plus, Trash2, X } from "lucide-react";
import type { Word } from "../locale/locale";
import { Popover } from "../ui/dialog";
import { Select, type Choice } from "../ui/Select";
import { RuleEditor } from "./RuleEditor";
import { FieldSettings } from "./FieldSettings";
import { fields } from "../database/fields";
import {
  layouts,
  readOnlyTypes,
  type Field,
  type Layout,
  type Row,
  type SortKey,
} from "../database/types";
import { renameOption } from "../database/rowEntries";
import {
  calculationsFor,
  type Calculation,
  type ComputeScope,
} from "../database/compute";
import { FieldIcon, layoutIcons } from "./icons";
import { renameField } from "./viewEdits";
import type { ChangeView, ViewContext } from "./types";

const COLUMN_WIDTH = 180;
const MAX_THEN_SORTS = 5;
const MAX_GROUPS = 7;

export interface MenuBase {
  anchor: DOMRect;
  context: ViewContext;
  close: () => void;
}

export function propertyChoices(schema: Field[], first: Choice): Choice[] {
  return [first, ...schema.map((f) => ({ value: f.id, label: f.name }))];
}

export function CalcMenu({
  anchor,
  context,
  close,
  field,
  change,
}: MenuBase & { field: string; change: ChangeView }) {
  const { active, db, t } = context;
  const choices = ["", ...calculationsFor(fields(db).get(field)?.type)];

  return (
    <Popover anchor={anchor} label={t("calculate")} close={close} width={240}>
      <div className="menu" role="menu">
        {choices.map((calc) => (
          <button
            key={calc || "none"}
            role="menuitemradio"
            aria-checked={(active.calcs?.[field] ?? "") === calc}
            onClick={() => {
              const calcs = { ...(active.calcs ?? {}) };

              if (calc) calcs[field] = calc as Calculation;
              else delete calcs[field];
              change({ calcs });
              close();
            }}
          >
            {calc ? t(calc as Word) : t("none")}
          </button>
        ))}
      </div>
    </Popover>
  );
}

export function BulkMenu({
  anchor,
  context,
  close,
  schema,
  store,
  edit,
}: MenuBase & {
  schema: Field[];
  store: (field: Field, value: string) => void;
  edit: (field: Field, anchor: DOMRect) => void;
}) {
  const { t } = context;
  const editable = schema.filter((f) => !readOnlyTypes.includes(f.type));
  const checkboxItem = (f: Field, value: "true" | "false") => (
    <button
      key={f.id + value}
      role="menuitem"
      onClick={() => {
        close();
        store(f, value);
      }}
    >
      <FieldIcon field={f} />
      {f.name}: {t(value === "true" ? "checked" : "unchecked")}
    </button>
  );
  const fieldItem = (f: Field) => (
    <button
      key={f.id}
      role="menuitem"
      onClick={() => {
        close();
        edit(f, anchor);
      }}
    >
      <FieldIcon field={f} />
      {f.name}
    </button>
  );

  return (
    <Popover anchor={anchor} label={t("setProperty")} close={close} width={260}>
      <div className="menu" role="menu">
        {editable.flatMap((f) =>
          f.type === "checkbox"
            ? (["true", "false"] as const).map((v) => checkboxItem(f, v))
            : [fieldItem(f)],
        )}
      </div>
    </Popover>
  );
}

export function FilterMenu({
  anchor,
  context,
  close,
  schema,
  change,
}: MenuBase & { schema: Field[]; change: ChangeView }) {
  const { active, book, t } = context;
  const groups = active.groups ?? [];

  return (
    <Popover anchor={anchor} label={t("filter")} close={close} width={360}>
      <div className="menu dbmenu">
        {!!active.groups?.length && (
          <Select
            label={t("combineGroups")}
            value={active.groupMatch ?? "all"}
            choices={["all", "any"].map((value) => ({
              value,
              label: t(value as Word),
            }))}
            change={(v) => change({ groupMatch: v === "any" ? "any" : "all" })}
          />
        )}
        <RuleEditor
          rules={active.filters}
          match={active.match}
          schema={schema}
          book={book}
          t={t}
          change={(filters, match) => change({ filters, match })}
        />
        {groups.map((g, i) => (
          <fieldset key={i}>
            <legend>
              {t("ruleGroup")} {i + 2}
            </legend>
            <RuleEditor
              rules={g.filters}
              match={g.match}
              schema={schema}
              book={book}
              t={t}
              change={(filters, match) =>
                change({
                  groups: active.groups?.map((item, j) =>
                    i === j ? { filters, match } : item,
                  ),
                })
              }
            />
            <button
              onClick={() =>
                change({ groups: active.groups?.filter((_, j) => j !== i) })
              }
            >
              {t("remove")}
            </button>
          </fieldset>
        ))}
        <button
          className="menuitem"
          disabled={groups.length >= MAX_GROUPS}
          onClick={() =>
            change({
              groups: [
                ...groups,
                { filters: [{ field: "", value: "" }], match: "all" },
              ],
            })
          }
        >
          <Plus size={16} />
          {t("newGroup")}
        </button>
      </div>
    </Popover>
  );
}

function SortRule({
  context,
  field,
  descending,
  label,
  choices,
  change,
  children,
}: {
  context: ViewContext;
  field: string;
  descending: boolean;
  label: string;
  choices: Choice[];
  change: (patch: Partial<SortKey>) => void;
  children?: ReactNode;
}) {
  const { t } = context;
  const directions = [
    { value: "ascending", label: t("ascending") },
    { value: "descending", label: t("descending") },
  ];

  return (
    <div className="rule">
      <Select
        label={label}
        value={field}
        choices={choices}
        change={(next) => change({ field: next })}
      />
      <Select
        label={t("sort")}
        value={descending ? "descending" : "ascending"}
        choices={directions}
        change={(order) => change({ descending: order === "descending" })}
      />
      {children}
    </div>
  );
}

export function SortMenu({
  anchor,
  context,
  close,
  schema,
  change,
}: MenuBase & { schema: Field[]; change: ChangeView }) {
  const { active, t } = context;
  const thenSort = active.thenSort ?? [];
  const titleChoices = propertyChoices(schema, {
    value: "",
    label: t("title"),
  });
  const changeThenSort = (index: number, patch: Partial<SortKey>) =>
    change({
      thenSort: thenSort.map((key, i) =>
        i === index ? { ...key, ...patch } : key,
      ),
    });

  return (
    <Popover anchor={anchor} label={t("sort")} close={close} width={340}>
      <div className="menu dbmenu">
        <SortRule
          context={context}
          field={active.sort}
          descending={active.descending}
          label={t("property")}
          choices={titleChoices}
          change={(patch) =>
            change(
              patch.field !== undefined
                ? { sort: patch.field }
                : { descending: patch.descending },
            )
          }
        />
        {thenSort.map((key, i) => (
          <SortRule
            key={i}
            context={context}
            field={key.field}
            descending={key.descending}
            label={t("thenSort")}
            choices={titleChoices}
            change={(patch) => changeThenSort(i, patch)}
          >
            <button
              className="ruleremove"
              aria-label={t("remove")}
              onClick={() =>
                change({ thenSort: active.thenSort?.filter((_, j) => i !== j) })
              }
            >
              <X size={14} />
            </button>
          </SortRule>
        ))}
        <button
          className="menuitem"
          disabled={thenSort.length >= MAX_THEN_SORTS}
          onClick={() =>
            change({
              thenSort: [...thenSort, { field: "", descending: false }],
            })
          }
        >
          <Plus size={16} />
          {t("thenSort")}
        </button>
      </div>
    </Popover>
  );
}

export function LayoutMenu({
  anchor,
  context,
  close,
  add,
}: MenuBase & { add: (type: Layout) => void }) {
  const { t } = context;

  return (
    <Popover anchor={anchor} label={t("newView")} close={close} width={220}>
      <div className="menu" role="menu">
        {layouts.map((type) => {
          const Icon = layoutIcons[type];

          return (
            <button
              key={type}
              role="menuitem"
              onClick={() => {
                close();
                add(type);
              }}
            >
              <Icon size={16} />
              {t(type)}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

export interface FieldMenuActions {
  update: (patch: Partial<Field>) => void;
  hide: () => void;
  remove: () => void;
}

export function FieldMenu({
  anchor,
  context,
  close,
  field,
  sample,
  scope,
  change,
  actions,
}: MenuBase & {
  field: Field;
  sample: Row | undefined;
  scope: ComputeScope;
  change: ChangeView;
  actions: FieldMenuActions;
}) {
  const { active, book, db, t } = context;

  return (
    <Popover anchor={anchor} label={field.name} close={close} width={320}>
      <div className="menu dbmenu">
        <input
          aria-label={t("name")}
          defaultValue={field.name}
          maxLength={200}
          onChange={(e) => renameField(db, field.id, e.target.value)}
        />
        <FieldSettings
          field={field}
          update={actions.update}
          book={book}
          db={db}
          sample={sample}
          scope={scope}
          t={t}
          editType
          editOptions
          renameOption={(from, to) =>
            void renameOption(book, db, field.id, from, to)
          }
        />
        <label className="menurow">
          <span className="grow">{t("width")}</span>
          <input
            type="range"
            min="100"
            max="480"
            value={active.widths[field.id] ?? COLUMN_WIDTH}
            onChange={(e) =>
              change({
                widths: {
                  ...active.widths,
                  [field.id]: Number(e.target.value),
                },
              })
            }
          />
        </label>
        <button className="menuitem" onClick={actions.hide}>
          <EyeOff size={16} />
          {t("hide")}
        </button>
        <button className="menuitem danger" onClick={actions.remove}>
          <Trash2 size={16} />
          {t("deleteProperty")}
        </button>
      </div>
    </Popover>
  );
}
