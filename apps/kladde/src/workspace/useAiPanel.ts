import { useEffect, useState } from "react";
import type { Notebook } from "../notebook/notebook";
import type { AiView } from "../agentPanel/types";
import { defaultPolicy, loadPolicy, type Policy } from "../ai/assistant";

export function useAiPanel(book: Notebook) {
  const [open, setOpen] = useState(false),
    [view, setView] = useState<AiView>("chat"),
    [prompt, setPrompt] = useState(""),
    [askReady, setAskReady] = useState(false),
    [policy, setPolicy] = useState<Policy>(defaultPolicy);

  useEffect(() => {
    let current = true;

    void loadPolicy(book.id).then((loaded) => {
      if (current) setPolicy(loaded);
    });

    return () => {
      current = false;
    };
  }, [book]);

  function show(nextView: AiView = "chat", nextPrompt = "") {
    setView(nextView);
    setPrompt(nextPrompt);
    setOpen(true);
  }

  return {
    open,
    view,
    setView,
    prompt,
    clearPrompt: () => setPrompt(""),
    askReady,
    setAskReady,
    policy,
    setPolicy,
    show,
    close: () => setOpen(false),
  };
}
