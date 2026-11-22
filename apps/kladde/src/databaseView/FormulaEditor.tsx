import type { MouseEvent } from "react";
import type { T } from "../locale/locale";
import type { Field } from "../database/types";
import { FORMULA_LENGTH } from "../database/formula/parser";
import { functionNames } from "../database/formula/functions";
import { useFormulaDraft, type FormulaOptions } from "./useFormulaDraft";

type Insert = (text: string) => void;

function keepFocus(event: MouseEvent) {
  event.preventDefault();
}

function propertyReference(field: Field) {
  return 'prop("' + field.name.replace(/"/g, '\\"') + '")';
}

function PropertyChips({
  others,
  insert,
}: {
  others: Field[];
  insert: Insert;
}) {
  return (
    <div className="formulachips">
      {others.map((field) => (
        <button
          type="button"
          key={field.id}
          className="chip"
          onMouseDown={keepFocus}
          onClick={() => insert(propertyReference(field))}
        >
          {field.name}
        </button>
      ))}
    </div>
  );
}

function FunctionChips({ insert, t }: { insert: Insert; t: T }) {
  return (
    <details>
      <summary>{t("formulaFunctions")}</summary>
      <div className="formulachips">
        {functionNames.map((name) => (
          <button
            type="button"
            key={name}
            className="chip code"
            onMouseDown={keepFocus}
            onClick={() => insert(name + "(")}
          >
            {name}
          </button>
        ))}
      </div>
    </details>
  );
}

export function FormulaEditor({
  live,
  ...options
}: FormulaOptions & { live?: boolean }) {
  const { field, update, t } = options;
  const formula = useFormulaDraft(options);
  const { draft, preview } = formula;

  return (
    <section className="formulaeditor">
      <h4>{t("formula")}</h4>
      <textarea
        ref={formula.input}
        aria-label={t("formula")}
        spellCheck={false}
        rows={3}
        maxLength={FORMULA_LENGTH}
        value={draft}
        placeholder={'prop("Preis") * prop("Menge")'}
        onChange={(event) => {
          formula.setDraft(event.target.value);
          if (live) update({ formula: event.target.value });
        }}
        onBlur={() => {
          if (draft !== (field.formula ?? "")) update({ formula: draft });
        }}
      />
      <p className="formulapreview" data-failed={preview.failed || undefined}>
        <span>{t("formulaPreview")}</span>
        <output>{preview.text}</output>
      </p>
      <p className="menuhint">{t("formulaHelp")}</p>
      <PropertyChips others={formula.others} insert={formula.insert} />
      <FunctionChips insert={formula.insert} t={t} />
    </section>
  );
}
