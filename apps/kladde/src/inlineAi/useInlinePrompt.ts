import { useState } from "react";

export function useInlinePrompt() {
  const [query, setQuery] = useState(""),
    [highlight, setHighlight] = useState(-1);

  function type(value: string) {
    setQuery(value);
    setHighlight(-1);
  }

  return { query, highlight, setHighlight, type, clear: () => type("") };
}

export type InlinePrompt = ReturnType<typeof useInlinePrompt>;
