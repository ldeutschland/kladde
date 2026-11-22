import { useMemo, useRef, useState } from "react";
import type { T, Word } from "../locale/locale";
import type { Field } from "../database/types";
import { fields } from "../database/fields";
import { evaluateFor } from "../database/compute";
import { FormulaError } from "../database/formula/errors";
import { FORMULA_LENGTH } from "../database/formula/parser";
import { storedValue } from "../database/formula/values";
import type { FieldSettingsProps } from "./FieldSettings";

export type FormulaOptions = Pick<
  FieldSettingsProps,
  "field" | "update" | "db" | "sample" | "scope" | "t"
>;

function formulaProblem(error: unknown, t: T) {
  if (!(error instanceof FormulaError)) return t("invalidValue");
  const label = t(("formulaError_" + error.code) as Word);

  return error.detail ? label + ": " + error.detail : label;
}

function formulaPreview(
  draft: string,
  { field, sample, scope, t }: FormulaOptions,
  schema: Field[],
) {
  if (!sample) return { text: t("formulaNoRows"), failed: false };
  const withDraft = schema.map((candidate) =>
    candidate.id === field.id ? { ...candidate, formula: draft } : candidate,
  );

  try {
    const value = storedValue(evaluateFor(draft, sample, withDraft, scope));

    return { text: value || t("formulaEmpty"), failed: false };
  } catch (error) {
    return { text: formulaProblem(error, t), failed: true };
  }
}

export function useFormulaDraft(options: FormulaOptions) {
  const { field, update, db, sample, scope, t } = options;
  const [draft, setDraft] = useState(field.formula ?? "");
  const input = useRef<HTMLTextAreaElement>(null);
  const schema = Array.from(fields(db).values());
  const others = schema.filter((candidate) => candidate.id !== field.id);
  const preview = useMemo(
    () => formulaPreview(draft, options, schema),
    [draft, sample, scope, field.id, schema, t],
  );

  function insert(text: string) {
    const element = input.current;
    const start = element?.selectionStart ?? draft.length;
    const end = element?.selectionEnd ?? draft.length;
    const next = (draft.slice(0, start) + text + draft.slice(end)).slice(
      0,
      FORMULA_LENGTH,
    );

    setDraft(next);
    update({ formula: next });
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + text.length, start + text.length);
    });
  }

  return { draft, setDraft, input, others, preview, insert };
}
