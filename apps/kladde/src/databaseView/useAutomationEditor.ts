import { useState } from "react";
import type { Entry, Notebook } from "../notebook/notebook";
import { fields } from "../database/fields";
import { type Field } from "../database/types";
import {
  applyAutomations,
  automations,
  automationSteps,
  needsValue,
  stepError,
  writableField,
  type Automation,
  type AutomationStep,
} from "../database/rules";
import { compile } from "../database/formula/parser";
import type { T } from "../locale/locale";

interface DraftCheck {
  steps: AutomationStep[];
  schema: Field[];
  writable: Field[];
  book: Notebook;
}

function stepProblem(
  step: AutomationStep,
  target: Field,
  schema: Field[],
  book: Notebook,
) {
  if (step.action === "formula") compile(step.value);

  return !!stepError(step, target, schema, book);
}

function draftProblem(
  draft: Automation,
  { steps, schema, writable, book }: DraftCheck,
) {
  const brokenStep = steps.some((step) => {
    const target = writable.find((field) => field.id === step.field);

    return !target || stepProblem(step, target, schema, book);
  });
  const missingValue = draft.filters.some(
    (filter) => !filter.value.trim() && needsValue(filter.op ?? "contains"),
  );

  return brokenStep || missingValue || !steps.length;
}

function rowProperties(row: Entry) {
  return JSON.stringify(row.doc.getMap("properties").toJSON());
}

async function runAutomation(book: Notebook, db: Entry, rule: Automation) {
  let count = 0;

  for (const page of book.pages.values()) {
    if (page.parent !== db.id || page.kind !== "row" || page.archived) continue;
    const row = await book.load(page.id);
    const before = rowProperties(row);

    applyAutomations(book, db, row, page.title, "manual", new Set(), rule.id);
    if (rowProperties(row) !== before) count++;
  }

  await book.flush();

  return count;
}

function newAutomation(writable: Field[]): Automation {
  const first = { field: writable[0].id, action: "set" as const, value: "" };

  return {
    id: crypto.randomUUID(),
    name: "",
    enabled: true,
    trigger: "create",
    watch: "",
    filters: [],
    match: "all",
    ...first,
    actions: [first],
  };
}

export function useAutomationEditor(book: Notebook, db: Entry, t: T) {
  const schema = Array.from(fields(db).values());
  const writable = schema.filter(writableField);
  const saved = automations(db);
  const [draft, setDraft] = useState<Automation | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const steps = draft ? automationSteps(draft) : [];
  const patch = (value: Partial<Automation>) =>
    draft && setDraft({ ...draft, ...value });
  const setSteps = (next: AutomationStep[]) =>
    patch({ actions: next, ...next[0] });

  async function run(rule: Automation) {
    setBusy(true);

    try {
      const count = await runAutomation(book, db, rule);

      setMessage(t("changedRows") + " · " + count);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!draft) return;

    try {
      if (draftProblem(draft, { steps, schema, writable, book })) throw Error();
      saved.set(draft.id, {
        ...draft,
        ...steps[0],
        actions: steps,
        name: draft.name.trim(),
      });
      setDraft(null);
      setMessage("");
    } catch {
      setMessage(t("invalidValue"));
    }
  }

  function open(rule: Automation) {
    setDraft(rule);
    setMessage("");
  }

  function create() {
    setMessage("");
    setDraft(newAutomation(writable));
  }

  function remove(rule: Automation) {
    saved.delete(rule.id);
    setDraft(null);
  }

  return {
    schema,
    writable,
    saved,
    draft,
    setDraft,
    message,
    busy,
    steps,
    patch,
    setSteps,
    run,
    save,
    open,
    create,
    remove,
  };
}
