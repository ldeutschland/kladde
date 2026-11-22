import { useLayoutEffect, useRef, useState } from "react";
import type { AiView } from "./types";

const MAX_INPUT_HEIGHT = 200;

export function useComposerDraft(view: AiView) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const field = input.current;

    if (!field) return;
    field.style.height = "auto";
    field.style.height = Math.min(field.scrollHeight, MAX_INPUT_HEIGHT) + "px";
  }, [draft, view]);

  function focus() {
    input.current?.focus();
  }

  function prefill(text: string) {
    setDraft(text);
    focus();
  }

  return { draft, setDraft, input, focus, prefill };
}

export type ComposerDraft = ReturnType<typeof useComposerDraft>;
