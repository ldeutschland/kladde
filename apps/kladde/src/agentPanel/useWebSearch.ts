import { useEffect, useRef, useState } from "react";
import type { Notebook } from "../notebook/notebook";
import { savePolicy, type Policy } from "../ai/assistant";

export function useWebSearch(
  book: Notebook,
  policy: Policy,
  setPolicy: (policy: Policy) => void,
) {
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const enabled = useRef(policy.web_search),
    streaming = useRef(false);

  useEffect(() => {
    enabled.current = policy.web_search;
  }, [policy.web_search]);

  async function toggle(stopRun: () => void) {
    if (saving) return;
    setSaving(true);

    try {
      const next = { ...policy, web_search: !policy.web_search };

      if (!next.web_search) {
        enabled.current = false;
        if (streaming.current) stopRun();
      }

      await savePolicy(book.id, next);
      enabled.current = next.web_search;
      setPolicy(next);
      setError("");
    } catch (problem) {
      enabled.current = policy.web_search;
      setError(String(problem));
    } finally {
      setSaving(false);
    }
  }

  return { saving, error, setError, enabled, streaming, toggle };
}

export type WebSearch = ReturnType<typeof useWebSearch>;
