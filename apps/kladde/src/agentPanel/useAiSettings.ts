import { useRef, useState, type FormEvent } from "react";
import { command } from "../platform/native";
import {
  loadModels,
  providerOf,
  savePolicy,
  type Policy,
  type Provider,
} from "../ai/assistant";
import type { LocalStatus } from "../ai/localModel";
import type { Notebook } from "../notebook/notebook";
import type { Ask } from "../ui/dialog";
import type { T } from "../locale/locale";
import { cloudAllowed, enabledPolicy } from "./aiConsent";

interface SettingsOptions {
  book: Notebook;
  policy: Policy;
  setPolicy: (policy: Policy) => void;
  local: LocalStatus | null;
  ask: Ask;
  t: T;
}

export function useAiSettings({
  book,
  policy,
  setPolicy,
  local,
  ask,
  t,
}: SettingsOptions) {
  const [models, setModels] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const keyField = useRef<HTMLInputElement>(null);

  async function change(patch: Partial<Policy>) {
    const next = { ...policy, ...patch };

    try {
      await savePolicy(book.id, next);
      setPolicy(next);
      setNote("");
    } catch (error) {
      setNote(String(error));
    }
  }

  async function refreshModels() {
    try {
      setModels(await loadModels(book.id));
      setNote("");
    } catch (error) {
      setNote(String(error));
    }
  }

  async function saveKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const field = keyField.current;
    const value = field?.value.trim() ?? "";

    if (!field || !value) return;
    field.value = "";

    try {
      await command("ai_key", { key: value });
      setNote(t("keySaved"));
      await refreshModels();
    } catch (error) {
      setNote(String(error));
    }
  }

  async function toggleEnabled() {
    if (policy.enabled) return change({ enabled: false });
    const next = await enabledPolicy(policy, local, ask, t);

    if (next) await change(next);
  }

  async function chooseProvider(provider: Provider) {
    if (provider === providerOf(policy)) return;
    if (provider === "openrouter" && !(await cloudAllowed(ask, t))) return;
    await change({ provider, web_search: false, model: "" });
  }

  async function toggleZdr() {
    if (
      !policy.zdr ||
      (await ask(t("zdrWarn"), undefined, {
        detail: t("zdrDetail"),
        action: t("allow"),
      }))
    )
      await change({ zdr: !policy.zdr });
  }

  return {
    models,
    note,
    keyField,
    change,
    refreshModels,
    saveKey,
    toggleEnabled,
    chooseProvider,
    toggleZdr,
  };
}
