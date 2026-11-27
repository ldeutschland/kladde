import { useCallback, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { command } from "../platform/native";

export type ModelState =
  "missing" | "partial" | "downloading" | "verifying" | "ready";

export interface LocalModelInfo {
  id: string;
  bytes: number;
  state: ModelState;
  received: number;
  supported: boolean;
}

interface ModelEvent {
  id?: unknown;
  state?: unknown;
  received?: unknown;
  reason?: unknown;
}

const MODEL_EVENT = "local-model";
const MODEL_NAMES: Record<string, string> = {
  "gemma-4-e2b": "Gemma 4 E2B",
  "gemma-4-e4b": "Gemma 4 E4B",
};
const PROGRESS_STATES = new Set<string>(["downloading", "verifying"]);

export function modelName(id: string) {
  return MODEL_NAMES[id] ?? id;
}

export async function localModels(): Promise<LocalModelInfo[]> {
  try {
    return await command<LocalModelInfo[]>("local_models");
  } catch {
    return [];
  }
}

export function downloadModel(id: string) {
  return command("local_model_download", { id });
}

export function cancelDownload(id: string) {
  return command("local_model_cancel", { id });
}

export function deleteModel(id: string) {
  return command("local_model_delete", { id });
}

function progressed(models: LocalModelInfo[], event: ModelEvent) {
  const { id, state, received } = event;

  if (typeof state !== "string" || !PROGRESS_STATES.has(state)) return models;
  if (typeof received !== "number") return models;

  return models.map((model) =>
    model.id === id
      ? { ...model, state: state as ModelState, received }
      : model,
  );
}

export function useLocalModels() {
  const [models, setModels] = useState<LocalModelInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState("");
  const refresh = useCallback(async () => {
    setModels(await localModels());
    setLoaded(true);
  }, []);

  useEffect(() => {
    let live = true;

    void refresh();
    if (!isTauri()) return;
    const attached = listen<ModelEvent>(MODEL_EVENT, ({ payload }) => {
      if (!live) return;
      if (payload.state === "failed")
        setFailure(typeof payload.reason === "string" ? payload.reason : "");
      if (payload.state === "failed" || payload.state === "ready")
        void refresh();
      else setModels((current) => progressed(current, payload));
    });

    return () => {
      live = false;
      void attached.then((stop) => stop());
    };
  }, [refresh]);

  return { models, loaded, failure, setFailure, refresh };
}
