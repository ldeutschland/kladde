import { useEffect } from "react";
import type { Policy } from "../ai/assistant";
import { localFailure, type LocalStatus } from "../ai/localModel";
import {
  cancelDownload,
  deleteModel,
  downloadModel,
  modelName,
  useLocalModels,
  type LocalModelInfo,
} from "../ai/localModels";
import type { Ask } from "../ui/dialog";
import type { T, Word } from "../locale/locale";

const BYTES_PER_GIGABYTE = 1e9;
const PERCENT = 100;
const MODEL_TRAITS: Record<string, Word> = {
  "gemma-4-e2b": "modelFast",
  "gemma-4-e4b": "modelThorough",
};
const sizes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

interface ModelActions {
  t: T;
  ask: Ask;
  refresh: () => Promise<void>;
  fail: (reason: string) => void;
}

function gigabytes(bytes: number) {
  return sizes.format(bytes / BYTES_PER_GIGABYTE) + " GB";
}

async function act(actions: ModelActions, work: () => Promise<unknown>) {
  actions.fail("");

  try {
    await work();
  } catch (error) {
    actions.fail(String(error));
  }

  await actions.refresh();
}

function download(model: LocalModelInfo, t: T) {
  const title = t("modelDownloadTitle").replace("{name}", modelName(model.id));

  return downloadModel(model.id, title);
}

async function remove(model: LocalModelInfo, actions: ModelActions) {
  const { t } = actions;
  const agreed = await actions.ask(t("modelDeleteAsk"), undefined, {
    detail: t("modelDeleteDetail"),
    action: t("delete"),
  });

  if (agreed) await act(actions, () => deleteModel(model.id));
}

function Progress({
  model,
  actions,
}: {
  model: LocalModelInfo;
  actions: ModelActions;
}) {
  const percent = Math.floor((model.received / model.bytes) * PERCENT);

  return (
    <>
      <progress
        max={PERCENT}
        value={percent}
        aria-label={modelName(model.id)}
      />
      <button onClick={() => void act(actions, () => cancelDownload(model.id))}>
        {actions.t("cancel")}
      </button>
    </>
  );
}

function ModelAction({
  model,
  actions,
}: {
  model: LocalModelInfo;
  actions: ModelActions;
}) {
  const { t } = actions;

  if (!model.supported) return <small>{t("modelTooLarge")}</small>;
  if (model.state === "verifying") return <small>{t("modelVerifying")}</small>;
  if (model.state === "downloading")
    return <Progress model={model} actions={actions} />;
  if (model.state === "ready")
    return (
      <button onClick={() => void remove(model, actions)}>{t("delete")}</button>
    );

  return (
    <button onClick={() => void act(actions, () => download(model, t))}>
      {t(model.state === "partial" ? "modelResume" : "modelDownload")}
    </button>
  );
}

function ModelRow({
  model,
  selected,
  choose,
  actions,
}: {
  model: LocalModelInfo;
  selected: boolean;
  choose: () => void;
  actions: ModelActions;
}) {
  const trait = MODEL_TRAITS[model.id];
  const details = [
    gigabytes(model.bytes),
    trait ? actions.t(trait) : "",
    selected ? actions.t("modelActive") : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="localmodel">
      <button
        className="modelchoice"
        aria-pressed={selected}
        disabled={model.state !== "ready"}
        onClick={choose}
      >
        <strong>{modelName(model.id)}</strong>
        <small>{details}</small>
      </button>
      <ModelAction model={model} actions={actions} />
    </div>
  );
}

function useReadyModel(
  models: LocalModelInfo[],
  loaded: boolean,
  selected: string,
  choose: (id: string) => void,
) {
  useEffect(() => {
    if (!loaded) return;
    const ready = models
      .filter((model) => model.state === "ready")
      .map((model) => model.id);

    if (ready.includes(selected)) return;
    const next = ready[0] ?? "";

    if (next !== selected) choose(next);
  }, [models, loaded, selected]);
}

export function LocalModels({
  policy,
  local,
  choose,
  ask,
  t,
}: {
  policy: Policy;
  local: LocalStatus | null;
  choose: (id: string) => void;
  ask: Ask;
  t: T;
}) {
  const { models, loaded, failure, setFailure, refresh } = useLocalModels();
  const actions = { t, ask, refresh, fail: setFailure };

  useReadyModel(models, loaded, policy.model, choose);

  return (
    <div className="localmodels">
      <p className="settinghint">{t("localHint")}</p>
      {local && !local.available && (
        <p role="status">{localFailure(local.reason, t)}</p>
      )}
      {models.map((model) => (
        <ModelRow
          key={model.id}
          model={model}
          selected={model.id === policy.model}
          choose={() => choose(model.id)}
          actions={actions}
        />
      ))}
      {failure && <p role="alert">{localFailure(failure, t)}</p>}
    </div>
  );
}
