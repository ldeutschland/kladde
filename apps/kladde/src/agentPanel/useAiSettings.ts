import { useRef, useState, type FormEvent } from "react";
import { command } from "../platform/native";
import { loadModels, savePolicy, type Policy } from "../ai/assistant";
import type { Notebook } from "../notebook/notebook";
import type { Ask } from "../ui/dialog";
import type { T } from "../locale/locale";

interface SettingsOptions {
  book: Notebook;
  policy: Policy;
  setPolicy: (policy: Policy) => void;
  ask: Ask;
  t: T;
}

export function useAiSettings({
  book,
  policy,
  setPolicy,
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
    if (
      policy.enabled ||
      (await ask(t("aiPrivacy"), undefined, {
        detail: t("aiPrivacyDetail"),
        action: t("aiEnable"),
      }))
    )
      await change({ enabled: !policy.enabled });
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
    toggleZdr,
  };
}
