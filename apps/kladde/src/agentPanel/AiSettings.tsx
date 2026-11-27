import { ArrowUpRight } from "lucide-react";
import { Select } from "../ui/Select";
import { memoryAuto, setMemoryAuto } from "../ai/aiPages";
import { onDevice, providerOf, type Policy } from "../ai/assistant";
import { localOffered, type LocalStatus } from "../ai/localModel";
import type { Notebook } from "../notebook/notebook";
import type { Ask } from "../ui/dialog";
import type { T } from "../locale/locale";
import { LocalModels } from "./LocalModels";
import { effectiveMode, modeChoices } from "./modes";
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

function ProviderField({ settings, policy, t }: SectionProps) {
  const choices = [
    { value: "local", label: t("localModel") },
    { value: "openrouter", label: t("cloudModel") },
  ];

  return (
    <label>
      {t("aiWhere")}
      <Select
        label={t("aiWhere")}
        value={providerOf(policy)}
        choices={choices}
        change={(next) =>
          void settings.chooseProvider(
            next === "local" ? "local" : "openrouter",
          )
        }
      />
    </label>
  );
}

function CloudModel(section: SectionProps) {
  return (
    <>
      <KeyForm settings={section.settings} t={section.t} />
      <ModelField {...section} />
    </>
  );
}

function CloudLimits(section: SectionProps) {
  const { settings, policy, t } = section;

  return (
    <>
      <SwitchItem
        label={t("zdr")}
        pressed={policy.zdr}
        toggle={() => void settings.toggleZdr()}
      />
      <LimitFields {...section} />
    </>
  );
}

function ModeField({
  book,
  mode,
  policy,
  t,
}: {
  book: Notebook;
  mode: string;
  policy: Policy;
  t: T;
}) {
  return (
    <label>
      {t("mode")}
      <Select
        label={t("mode")}
        value={effectiveMode(mode, policy)}
        choices={modeChoices(t, policy)}
        change={(next) => book.settings.set("agentMode", next)}
      />
    </label>
  );
}

function MemorySettings({
  book,
  t,
  openHome,
}: {
  book: Notebook;
  t: T;
  openHome: () => void;
}) {
  return (
    <>
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
    </>
  );
}

function EnabledSettings({
  book,
  mode,
  openHome,
  local,
  ask,
  ...section
}: SectionProps & {
  book: Notebook;
  mode: string;
  openHome: () => void;
  local: LocalStatus | null;
  ask: Ask;
}) {
  const { policy, settings, t } = section;
  const onPhone = onDevice(policy);

  return (
    <>
      {(onPhone || localOffered(local)) && <ProviderField {...section} />}
      {onPhone ? (
        <LocalModels
          policy={policy}
          local={local}
          choose={(model) => void settings.change({ model })}
          ask={ask}
          t={t}
        />
      ) : (
        <CloudModel {...section} />
      )}
      <ModeField book={book} mode={mode} policy={policy} t={t} />
      {onPhone && <p className="settinghint">{t("localDrafts")}</p>}
      <MemorySettings book={book} t={t} openHome={openHome} />
      {!onPhone && <CloudLimits {...section} />}
    </>
  );
}

function introWord(policy: Policy, local: LocalStatus | null) {
  const prefersDevice = policy.enabled ? onDevice(policy) : localOffered(local);

  return prefersDevice ? "aiIntroLocal" : "aiIntro";
}

export function AiSettings({
  book,
  policy,
  setPolicy,
  local,
  mode,
  ask,
  t,
  openHome,
}: {
  book: Notebook;
  policy: Policy;
  setPolicy: (policy: Policy) => void;
  local: LocalStatus | null;
  mode: string;
  ask: Ask;
  t: T;
  openHome: () => void;
}) {
  const settings = useAiSettings({ book, policy, setPolicy, local, ask, t });

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
          local={local}
          ask={ask}
          settings={settings}
          policy={policy}
          t={t}
        />
      )}
      <p className="muted">{t(introWord(policy, local))}</p>
      {settings.note && <p role="status">{settings.note}</p>}
    </div>
  );
}
