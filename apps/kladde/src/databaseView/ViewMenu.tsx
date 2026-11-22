import { Eye, EyeOff, Palette, Plus, Trash2, WrapText, X } from "lucide-react";
import type { Word } from "../locale/locale";
import { Popover } from "../ui/dialog";
import { Select } from "../ui/Select";
import { RuleEditor } from "./RuleEditor";
import { type Field, type Tint, type View } from "../database/types";
import { FieldIcon } from "./icons";
import { propertyChoices, type MenuBase } from "./menus";
import type { ChangeView, ViewContext } from "./types";

const MAX_TINTS = 12;
const TINT_COLORS = 9;
const NEW_TINT_COLOR = 3;

type Calculation = NonNullable<View["summary"]>["calculation"];

function SummarySettings({
  context,
  schema,
  change,
}: {
  context: ViewContext;
  schema: Field[];
  change: ChangeView;
}) {
  const { active, t } = context;
  const numeric = schema.filter((f) => f.type === "number");
  const calculations = numeric.length
    ? ["count", "sum", "average", "minimum", "maximum"]
    : ["count"];

  return (
    <>
      <label className="menurow">
        {t("summaryDb")}
        <Select
          label={t("summaryDb")}
          value={active.summary?.calculation ?? ""}
          choices={[
            { value: "", label: t("none") },
            ...calculations.map((value) => ({
              value,
              label: t(value as Word),
            })),
          ]}
          change={(v) =>
            change({
              summary: v
                ? {
                    calculation: v as Calculation,
                    field: active.summary?.field || numeric[0]?.id || "",
                  }
                : undefined,
            })
          }
        />
      </label>
      {active.summary && active.summary.calculation !== "count" && (
        <Select
          label={t("property")}
          value={active.summary.field}
          choices={numeric.map((f) => ({ value: f.id, label: f.name }))}
          change={(field) => change({ summary: { ...active.summary!, field } })}
        />
      )}
    </>
  );
}

function TintRules({
  context,
  schema,
  change,
}: {
  context: ViewContext;
  schema: Field[];
  change: ChangeView;
}) {
  const { active, book, t } = context;
  const tints = active.tints ?? [];
  const updateTint = (index: number, patch: Partial<Tint>) =>
    change({
      tints: tints.map((tint, i) =>
        i === index ? { ...tint, ...patch } : tint,
      ),
    });

  return (
    <>
      {tints.map((tint, i) => (
        <fieldset className="tintrule" key={i} data-tint={tint.color}>
          <div className="swatches">
            {Array.from({ length: TINT_COLORS }, (_, color) => (
              <button
                key={color}
                className="tag swatch"
                data-color={color}
                aria-pressed={tint.color === color}
                aria-label={t("color") + " " + (color + 1)}
                onClick={() => updateTint(i, { color })}
              />
            ))}
            <button
              className="grow end"
              aria-label={t("remove")}
              onClick={() =>
                change({ tints: active.tints?.filter((_, j) => j !== i) })
              }
            >
              <X size={14} />
            </button>
          </div>
          <RuleEditor
            rules={tint.filters}
            match={tint.match}
            schema={schema}
            book={book}
            t={t}
            change={(filters, match) => updateTint(i, { filters, match })}
          />
        </fieldset>
      ))}
      <button
        className="menuitem"
        disabled={tints.length >= MAX_TINTS}
        onClick={() =>
          change({
            tints: [
              ...tints,
              {
                filters: [{ field: "", value: "" }],
                match: "all",
                color: NEW_TINT_COLOR,
              },
            ],
          })
        }
      >
        <Plus size={16} />
        {t("newTint")}
      </button>
    </>
  );
}

function FieldVisibility({
  context,
  schema,
  shown,
  toggle,
}: {
  context: ViewContext;
  schema: Field[];
  shown: string[];
  toggle: (id: string) => void;
}) {
  const { t } = context;

  return (
    <>
      <h4>{t("properties")}</h4>
      {schema.map((f) => (
        <button
          className="menuitem"
          key={f.id}
          aria-pressed={shown.includes(f.id)}
          onClick={() => toggle(f.id)}
        >
          <FieldIcon field={f} />
          <span className="grow">{f.name}</span>
          {shown.includes(f.id) ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
      ))}
    </>
  );
}

export interface ViewMenuActions {
  toggleField: (id: string) => void;
  addField: () => void;
  deleteView: () => void;
}

export function ViewMenu({
  anchor,
  context,
  close,
  schema,
  shown,
  canDelete,
  change,
  actions,
}: MenuBase & {
  schema: Field[];
  shown: string[];
  canDelete: boolean;
  change: ChangeView;
  actions: ViewMenuActions;
}) {
  const { active, t } = context;

  return (
    <Popover
      anchor={anchor}
      label={t("viewSettings")}
      close={close}
      width={380}
    >
      <div className="menu dbmenu">
        <input
          aria-label={t("name")}
          defaultValue={active.name}
          maxLength={200}
          onChange={(e) => {
            const name = e.target.value.trim();

            if (name) change({ name });
          }}
        />
        <SummarySettings context={context} schema={schema} change={change} />
        <label className="menurow">
          <span className="grow">{t("group")}</span>
          <Select
            label={t("group")}
            value={active.group}
            choices={propertyChoices(schema, { value: "", label: t("none") })}
            change={(group) => change({ group })}
          />
        </label>
        {(active.type === "table" || active.type === "list") && (
          <button
            className="switchitem"
            aria-pressed={!!active.wrap}
            onClick={() => change({ wrap: !active.wrap })}
          >
            <WrapText size={16} />
            <span className="grow">{t("wrapContent")}</span>
            <span className="switch" />
          </button>
        )}
        <h4 className="menuhead">
          <Palette size={14} />
          {t("tints")}
        </h4>
        <p className="menuhint">{t("tintsHint")}</p>
        <TintRules context={context} schema={schema} change={change} />
        <FieldVisibility
          context={context}
          schema={schema}
          shown={shown}
          toggle={actions.toggleField}
        />
        <button className="menuitem" onClick={actions.addField}>
          <Plus size={16} />
          {t("newProperty")}
        </button>
        <hr />
        <button
          className="menuitem danger"
          disabled={!canDelete}
          onClick={actions.deleteView}
        >
          <Trash2 size={16} />
          {t("deleteView")}
        </button>
      </div>
    </Popover>
  );
}
