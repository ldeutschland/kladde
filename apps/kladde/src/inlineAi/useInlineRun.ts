import { useEffect, useRef, useState } from "react";
import {
  aiReady,
  onDevice,
  startRun,
  stopRun,
  streamTurn,
  type Message,
  type Policy,
} from "../ai/assistant";
import {
  completeLocally,
  localFailure,
  localTextLimit,
  stopAnyRun,
  useLocalStatus,
} from "../ai/localModel";
import type { T } from "../locale/locale";

export function useInlineRun(
  space: string,
  policy: Policy,
  clearPrompt: () => void,
  t: T,
) {
  const [result, setResult] = useState(""),
    [asked, setAsked] = useState<Message[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    stopped = useRef(false),
    active = useRef("");
  const ready = aiReady(policy);
  const local = onDevice(policy);
  const status = useLocalStatus();

  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
      stopped.current = true;
      stopAnyRun(active.current);
    };
  }, []);

  async function generated(messages: Message[]) {
    const show = (text: string) => {
      if (alive.current) setResult(text);
    };

    if (local) return completeLocally(space, messages, show, active);
    active.current = await startRun(space);
    const turn = await streamTurn(
      active.current,
      messages,
      [],
      show,
      () => stopped.current,
    );

    if (turn.calls.length) throw Error("Unexpected tool call");

    return turn.content;
  }

  async function stream(messages: Message[]) {
    const content = await generated(messages);

    if (!alive.current) return;
    setResult(content);
    setAsked([...messages, { role: "assistant", content }]);
  }

  async function ask(messages: Message[]) {
    if (!ready || busy) return;
    stopped.current = false;
    setAsked(messages);
    setBusy(true);
    setError("");
    clearPrompt();
    setResult("");

    try {
      await stream(messages);
    } catch (problem) {
      if (alive.current && !stopped.current)
        setError(local ? localFailure(problem, t) : String(problem));
    } finally {
      await stopRun(active.current);
      active.current = "";
      if (alive.current) setBusy(false);
    }
  }

  function retry() {
    if (!asked.length) return;
    const last = asked[asked.length - 1];

    void ask(last.role === "assistant" ? asked.slice(0, -1) : asked);
  }

  function stop() {
    stopped.current = true;
    stopAnyRun(active.current);
  }

  function textLimit(fallback: number) {
    return local ? localTextLimit(status, fallback) : fallback;
  }

  return {
    ready,
    result,
    asked,
    busy,
    error,
    setError,
    ask,
    retry,
    stop,
    textLimit,
  };
}

export type InlineRun = ReturnType<typeof useInlineRun>;
