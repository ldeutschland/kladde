import { Plus } from "lucide-react";
import type { Entry, Notebook } from "../notebook/notebook";
import { STEP_LIMIT, type Automation } from "../database/rules";
import type { T, Word } from "../locale/locale";
import { Select } from "../ui/Select";
import { Panel } from "../ui/dialog";
import { RuleEditor } from "./RuleEditor";
import { StepEditor } from "./StepEditor";
import { useAutomationEditor } from "./useAutomationEditor";

const AUTOMATION_LIMIT = 32;
const NAME_LENGTH = 100;

type AutomationEditor = ReturnType<typeof useAutomationEditor>;

interface EditorProps {
  editor: AutomationEditor;
  book: Notebook;
  t: T;
}

interface DraftProps extends EditorProps {
  draft: Automation;
}

function AutomationList({ editor, t }: Omit<EditorProps, "book">) {
  const { saved, writable, busy } = editor;

  return (
    <>
      {Array.from(saved.values()).map((rule) => (
        <div className="menurow" key={rule.id}>
          <input
            type="checkbox"
            aria-label={t("ruleEnabled")}
            checked={rule.enabled}
            disabled={busy}
            onChange={(event) =>
              saved.set(rule.id, { ...rule, enabled: event.target.checked })
            }
          />
          <button
            className="grow"
            disabled={busy}
            onClick={() => editor.open(rule)}
          >
            {rule.name}
          </button>
          {rule.trigger === "manual" && (
            <button
              disabled={busy || !rule.enabled}
              onClick={() => void editor.run(rule)}
            >
              {t("runRule")}
            </button>
          )}
        </div>
      ))}
      <button
        disabled={busy || !writable.length || saved.size >= AUTOMATION_LIMIT}
        onClick={editor.create}
      >
        {t("newRule")}
      </button>
      {!writable.length && <p>{t("needsProperty")}</p>}
    </>
  );
}

function DraftTrigger({ editor, draft, t }: Omit<DraftProps, "book">) {
  return (
    <>
      <Select
        label={t("trigger")}
        value={draft.trigger}
        choices={["create", "change", "manual"].map((value) => ({
          value,
          label: t(("trigger_" + value) as Word),
        }))}
        change={(value) =>
          editor.patch({ trigger: value as Automation["trigger"] })
        }
      />
      {draft.trigger === "change" && (
        <Select
          label={t("watchProperty")}
          value={draft.watch}
          choices={[
            { value: "", label: t("anyProperty") },
            ...editor.writable.map((field) => ({
              value: field.id,
              label: field.name,
            })),
          ]}
          change={(watch) => editor.patch({ watch })}
        />
      )}
    </>
  );
}

function DraftSteps({ editor, book, t }: EditorProps) {
  const { steps, setSteps } = editor;

  return (
    <>
      {steps.map((step, index) => (
        <StepEditor
          key={index}
          step={step}
          schema={editor.schema}
          writable={editor.writable}
          book={book}
          t={t}
          change={(next) =>
            setSteps(
              steps.map((current, position) =>
                index === position ? next : current,
              ),
            )
          }
          remove={
            steps.length > 1
              ? () =>
                  setSteps(steps.filter((_, position) => index !== position))
              : undefined
          }
        />
      ))}
      <button
        className="menuitem"
        disabled={steps.length >= STEP_LIMIT}
        onClick={() =>
          setSteps([
            ...steps,
            { field: editor.writable[0]?.id ?? "", action: "set", value: "" },
          ])
        }
      >
        <Plus size={16} />
        {t("addStep")}
      </button>
    </>
  );
}

function DraftFooter({ editor, draft, t }: Omit<DraftProps, "book">) {
  return (
    <footer>
      {editor.saved.has(draft.id) && (
        <button onClick={() => editor.remove(draft)}>{t("remove")}</button>
      )}
      <button onClick={() => editor.setDraft(null)}>{t("cancel")}</button>
      <button
        className="primary"
        disabled={!draft.name.trim() || !editor.steps.length}
        onClick={editor.save}
      >
        {t("save")}
      </button>
    </footer>
  );
}

function DraftForm(props: DraftProps) {
  const { editor, draft, book, t } = props;

  return (
    <>
      <label>
        {t("name")}
        <input
          value={draft.name}
          maxLength={NAME_LENGTH}
          onChange={(event) => editor.patch({ name: event.target.value })}
        />
      </label>
      <DraftTrigger {...props} />
      <h4>{t("conditions")}</h4>
      <RuleEditor
        rules={draft.filters}
        match={draft.match}
        schema={editor.schema.filter((field) => field.type !== "button")}
        book={book}
        t={t}
        change={(filters, match) => editor.patch({ filters, match })}
      />
      <h4>{t("actions")}</h4>
      <DraftSteps {...props} />
      <DraftFooter {...props} />
    </>
  );
}

export function AutomationPanel({
  book,
  db,
  t,
  close,
}: {
  book: Notebook;
  db: Entry;
  t: T;
  close: () => void;
}) {
  const editor = useAutomationEditor(book, db, t);
  const { draft, message, busy } = editor;

  return (
    <Panel
      title={t("automations")}
      t={t}
      close={() => {
        if (!busy) close();
      }}
    >
      <div className="automationform">
        {!draft && <AutomationList editor={editor} t={t} />}
        {draft && <DraftForm editor={editor} draft={draft} book={book} t={t} />}
        {message && <p role="status">{message}</p>}
      </div>
    </Panel>
  );
}
