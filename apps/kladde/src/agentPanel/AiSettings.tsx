import { ArrowUpRight } from "lucide-react";
import { Select } from "../ui/Select";
import { memoryAuto, setMemoryAuto } from "../ai/aiPages";
import type { Policy } from "../ai/assistant";
import type { Notebook } from "../notebook/notebook";
import type { Ask } from "../ui/dialog";
import type { T } from "../locale/locale";
import { modeChoices } from "./modes";
import { useAiSettings } from "./useAiSettings";

const BUDGET_MAX = 50;
const STEPS_MAX = 100;

type Settings = ReturnType<typeof useAiSettings>;

interface SectionProps {
  settings: Settings;
  policy: Policy;
  t: T;
}

function validBudget(budget: number) {
  return Number.isFinite(budget) && budget > 0 && budget <= BUDGET_MAX;
}

function validSteps(steps: number) {
  return Number.isInteger(steps) && steps >= 1 && steps <= STEPS_MAX;
}

function SwitchItem({
  label,
  pressed,
  toggle,
}: {
  label: string;
  pressed: boolean;
  toggle: () => void;
}) {
  return (
    <button className="switchitem" aria-pressed={pressed} onClick={toggle}>
      {label}
      <span className="switch" />
    </button>
  );
}

function KeyForm({ settings, t }: Omit<SectionProps, "policy">) {
  return (
    <form onSubmit={(event) => void settings.saveKey(event)}>
      <label>
        {t("apiKey")}
        <span className="aifield">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            ref={settings.keyField}
          />
          <button>{t("save")}</button>
        </span>
      </label>
    </form>
  );
}

function ModelField({ settings, policy, t }: SectionProps) {
  const choices = [
    { value: "", label: t("choose") },
    ...[...new Set([policy.model, ...settings.models])]
      .filter(Boolean)
      .map((model) => ({ value: model, label: model })),
  ];

  return (
    <label>
      {t("model")}
      <span className="aifield">
        <Select
          label={t("model")}
          searchLabel={t("search")}
          value={policy.model}
          choices={choices}
          change={(model) => void settings.change({ model })}
        />
        <button type="button" onClick={settings.refreshModels}>
          {t("models")}
        </button>
      </span>
    </label>
  );
}

function LimitFields({ settings, policy, t }: SectionProps) {
  return (
    <>
      <label>
        {t("limit")}
        <input
          type="number"
          min="0.01"
          max={String(BUDGET_MAX)}
          step="0.01"
          defaultValue={policy.budget}
          onBlur={(event) => {
            const budget = Number(event.target.value);

            if (validBudget(budget)) void settings.change({ budget });
          }}
        />
      </label>
      <label>
        {t("stepLimit")}
        <input
          type="number"
          min="1"
          max={String(STEPS_MAX)}
          defaultValue={policy.steps}
          onBlur={(event) => {
            const steps = Number(event.target.value);

            if (validSteps(steps)) void settings.change({ steps });
          }}
        />
      </label>
    </>
  );
}

function EnabledSettings({
  book,
  mode,
  openHome,
  ...section
}: SectionProps & { book: Notebook; mode: string; openHome: () => void }) {
  const { settings, policy, t } = section;

  return (
    <>
      <KeyForm settings={settings} t={t} />
      <ModelField {...section} />
      <label>
        {t("mode")}
        <Select
          label={t("mode")}
          value={mode}
          choices={modeChoices(t)}
          change={(next) => book.settings.set("agentMode", next)}
        />
      </label>
      <SwitchItem
        label={t("aiMemoryAuto")}
        pressed={memoryAuto(book)}
        toggle={() => setMemoryAuto(book, !memoryAuto(book))}
      />
      <p className="settinghint">{t("aiMemoryAutoHint")}</p>
      <button className="settinglink" onClick={openHome}>
        <ArrowUpRight />
        <span className="grow">{t("aiOpenHome")}</span>
      </button>
      <p className="settinghint">{t("aiOpenHomeHint")}</p>
      <SwitchItem
        label={t("zdr")}
        pressed={policy.zdr}
        toggle={() => void settings.toggleZdr()}
      />
      <LimitFields {...section} />
    </>
  );
}

export function AiSettings({
  book,
  policy,
  setPolicy,
  mode,
  ask,
  t,
  openHome,
}: {
  book: Notebook;
  policy: Policy;
  setPolicy: (policy: Policy) => void;
  mode: string;
  ask: Ask;
  t: T;
  openHome: () => void;
}) {
  const settings = useAiSettings({ book, policy, setPolicy, ask, t });

  return (
    <div className="aisettings">
      <SwitchItem
        label={t("enabled")}
        pressed={policy.enabled}
        toggle={() => void settings.toggleEnabled()}
      />
      {policy.enabled && (
        <EnabledSettings
          book={book}
          mode={mode}
          openHome={openHome}
          settings={settings}
          policy={policy}
          t={t}
        />
      )}
      <p className="muted">{t("aiIntro")}</p>
      {settings.note && <p role="status">{settings.note}</p>}
    </div>
  );
}
