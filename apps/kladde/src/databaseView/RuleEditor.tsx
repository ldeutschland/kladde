import { Plus, X } from "lucide-react";
import type { Notebook } from "../notebook/notebook";
import { type Field, type Rule } from "../database/types";
import { needsValue, operators } from "../database/rules";
import type { T, Word } from "../locale/locale";
import { Select } from "../ui/Select";

const RULE_LIMIT = 32;
const RELATIVE_DAYS_MAX = 3650;
const RULE_VALUE_LENGTH = 200;
const CHOICE_FIELDS = ["select", "multi", "status"];
const DATE_FIELDS = ["created", "edited", "date"];

type Match = "all" | "any";

export function valueChoices(field: Field | undefined, book: Notebook) {
  if (!field) return [];
  if (CHOICE_FIELDS.includes(field.type))
    return field.options.map((value) => ({ value, label: value }));
  if (field.type === "relation")
    return Array.from(book.pages.values())
      .filter(
        (page) =>
          !page.archived && page.kind === "row" && page.parent === field.target,
      )
      .map((page) => ({ value: page.id, label: page.title }));

  return [];
}

function ruleOperators(field: Field | undefined, rule: Rule) {
  const choices = operators(field?.type);
  const operator = rule.op ?? "contains";

  if (!choices.includes(operator) && !rule.op) choices.unshift(operator);

  return { choices, operator };
}

function isRelative(operator: string) {
  return operator === "pastDays" || operator === "nextDays";
}

function ruleInputType(field: Field | undefined, rule: Rule, operator: string) {
  if (isRelative(operator)) return "number";
  if (field?.type === "number" || field?.type === "autoId") return "number";
  if (field && DATE_FIELDS.includes(field.type) && rule.op) return "date";

  return "text";
}

interface RuleLineProps {
  rule: Rule;
  schema: Field[];
  book: Notebook;
  t: T;
  update: (rule: Rule) => void;
  remove: () => void;
}

function propertyChoices(schema: Field[], t: T) {
  return [
    { value: "", label: t("title") },
    ...schema
      .filter((field) => field.type !== "button")
      .map((field) => ({ value: field.id, label: field.name })),
  ];
}

function RuleValue({ rule, schema, book, t, update }: RuleLineProps) {
  const field = schema.find((candidate) => candidate.id === rule.field);
  const { operator } = ruleOperators(field, rule);
  const choices = valueChoices(field, book);
  const relative = isRelative(operator);
  const label = t(operator === "contains" ? "contains" : "ruleValue");

  if (choices.length && rule.op && operator !== "contains")
    return (
      <Select
        label={t("ruleValue")}
        value={rule.value}
        choices={choices}
        change={(value) => update({ ...rule, value })}
      />
    );

  return (
    <input
      type={ruleInputType(field, rule, operator)}
      min={relative ? 1 : undefined}
      max={relative ? RELATIVE_DAYS_MAX : undefined}
      maxLength={RULE_VALUE_LENGTH}
      placeholder={label}
      aria-label={label}
      value={rule.value}
      onChange={(event) => update({ ...rule, value: event.target.value })}
    />
  );
}

function RuleLine(props: RuleLineProps) {
  const { rule, schema, t, update, remove } = props;
  const field = schema.find((candidate) => candidate.id === rule.field);
  const { choices, operator } = ruleOperators(field, rule);

  return (
    <div className="ruleline">
      <Select
        label={t("property")}
        value={rule.field}
        choices={propertyChoices(schema, t)}
        change={(id) =>
          update({
            field: id,
            op: operators(
              schema.find((candidate) => candidate.id === id)?.type,
            )[0],
            value: "",
          })
        }
      />
      <Select
        label={t("operator")}
        value={operator}
        choices={choices.map((value) => ({ value, label: t(value as Word) }))}
        change={(op) => update({ field: rule.field, op, value: "" })}
      />
      {needsValue(operator) && <RuleValue {...props} />}
      {operator === "between" && (
        <input
          type={ruleInputType(field, rule, operator)}
          aria-label={t("rangeEnd")}
          value={rule.end ?? ""}
          onChange={(event) => update({ ...rule, end: event.target.value })}
        />
      )}
      <button aria-label={t("remove")} onClick={remove}>
        <X size={14} />
      </button>
    </div>
  );
}

export function RuleEditor({
  rules,
  match,
  schema,
  book,
  change,
  t,
}: {
  rules: Rule[];
  match: Match;
  schema: Field[];
  book: Notebook;
  t: T;
  change: (rules: Rule[], match: Match) => void;
}) {
  const update = (index: number, rule: Rule) =>
    change(
      rules.map((current, position) => (position === index ? rule : current)),
      match,
    );
  const remove = (index: number) =>
    change(
      rules.filter((_, position) => position !== index),
      match,
    );

  return (
    <div className="ruleeditor">
      {rules.length > 1 && (
        <Select
          label={t("filter")}
          value={match}
          choices={["all", "any"].map((value) => ({
            value,
            label: t(value as Word),
          }))}
          change={(value) => change(rules, value === "any" ? "any" : "all")}
        />
      )}
      {rules.map((rule, index) => (
        <RuleLine
          key={index}
          rule={rule}
          schema={schema}
          book={book}
          t={t}
          update={(next) => update(index, next)}
          remove={() => remove(index)}
        />
      ))}
      <button
        className="menuitem"
        disabled={rules.length >= RULE_LIMIT}
        onClick={() => change([...rules, { field: "", value: "" }], match)}
      >
        <Plus size={16} />
        {t("filter")}
      </button>
    </div>
  );
}
