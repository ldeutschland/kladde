import { X } from "lucide-react";
import type { Notebook } from "../notebook/notebook";
import { type Field } from "../database/types";
import {
  actionsFor,
  type ActionKind,
  type AutomationStep,
} from "../database/rules";
import type { T, Word } from "../locale/locale";
import { Select } from "../ui/Select";
import { valueChoices } from "./RuleEditor";

const STEP_VALUE_LENGTH = 8192;
const numberActions: ActionKind[] = ["dateOffset", "increment"];
const silentActions: ActionKind[] = ["clear", "stamp", "toggle"];
const optionActions: ActionKind[] = ["set", "addOption", "removeOption"];

interface StepValueProps {
  step: AutomationStep;
  target: Field | undefined;
  schema: Field[];
  book: Notebook;
  t: T;
  patch: (value: Partial<AutomationStep>) => void;
}

function setChoices(target: Field | undefined, book: Notebook, t: T) {
  if (target?.type === "checkbox")
    return [
      { value: "true", label: t("checked") },
      { value: "false", label: t("unchecked") },
    ];

  return valueChoices(target, book);
}

function textInputType(step: AutomationStep, target: Field | undefined) {
  if (step.action !== "set") return "text";
  if (target?.type === "date" || target?.type === "number") return target.type;

  return "text";
}

function SourceSelect({ step, target, schema, t, patch }: StepValueProps) {
  return (
    <Select
      label={t("sourceProperty")}
      value={step.value}
      choices={schema
        .filter((field) => field.id !== target?.id && field.type !== "button")
        .map((field) => ({ value: field.id, label: field.name }))}
      change={(value) => patch({ value })}
    />
  );
}

function StepValue(props: StepValueProps) {
  const { step, target, book, t, patch } = props;
  const options = setChoices(target, book, t);
  const numberLabel = t(
    step.action === "dateOffset" ? "offsetDays" : "ruleValue",
  );

  if (step.action === "copy") return <SourceSelect {...props} />;
  if (step.action === "formula")
    return (
      <textarea
        className="code"
        aria-label={t("formula")}
        spellCheck={false}
        rows={2}
        maxLength={STEP_VALUE_LENGTH}
        placeholder={'prop("Menge") * 2'}
        value={step.value}
        onChange={(event) => patch({ value: event.target.value })}
      />
    );
  if (numberActions.includes(step.action))
    return (
      <input
        type="number"
        aria-label={numberLabel}
        placeholder={numberLabel}
        value={step.value}
        onChange={(event) => patch({ value: event.target.value })}
      />
    );
  if (optionActions.includes(step.action) && options.length)
    return (
      <Select
        label={t("ruleValue")}
        value={step.value}
        choices={options}
        change={(value) => patch({ value })}
      />
    );
  if (silentActions.includes(step.action)) return null;

  return (
    <input
      aria-label={t("ruleValue")}
      placeholder={t("ruleValue")}
      type={textInputType(step, target)}
      maxLength={STEP_VALUE_LENGTH}
      value={step.value}
      onChange={(event) => patch({ value: event.target.value })}
    />
  );
}

export function StepEditor({
  step,
  schema,
  writable,
  book,
  t,
  change,
  remove,
}: {
  step: AutomationStep;
  schema: Field[];
  writable: Field[];
  book: Notebook;
  t: T;
  change: (step: AutomationStep) => void;
  remove?: () => void;
}) {
  const target = writable.find((field) => field.id === step.field);
  const patch = (value: Partial<AutomationStep>) =>
    change({ ...step, ...value });

  return (
    <fieldset className="automationstep">
      <div className="ruleline">
        <Select
          label={t("targetProperty")}
          value={step.field}
          choices={writable.map((field) => ({
            value: field.id,
            label: field.name,
          }))}
          change={(field) => change({ field, action: "set", value: "" })}
        />
        <Select
          label={t("action")}
          value={step.action}
          choices={actionsFor(target?.type).map((value) => ({
            value,
            label: t(("action_" + value) as Word),
          }))}
          change={(value) => patch({ action: value as ActionKind, value: "" })}
        />
        {remove && (
          <button aria-label={t("remove")} onClick={remove}>
            <X size={14} />
          </button>
        )}
      </div>
      <StepValue
        step={step}
        target={target}
        schema={schema}
        book={book}
        t={t}
        patch={patch}
      />
    </fieldset>
  );
}
