import { useEffect, useRef, useState } from "react";
import {
  startRun,
  stopRun,
  streamTurn,
  type Message,
  type Policy,
} from "../ai/assistant";

export function useInlineRun(
  space: string,
  policy: Policy,
  clearPrompt: () => void,
) {
  const [result, setResult] = useState(""),
    [asked, setAsked] = useState<Message[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    stopped = useRef(false),
    active = useRef("");
  const ready = policy.enabled && !!policy.model;

  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
      stopped.current = true;
      void stopRun(active.current);
    };
  }, []);

  async function stream(messages: Message[]) {
    active.current = await startRun(space);
    const turn = await streamTurn(
      active.current,
      messages,
      [],
      (text) => {
        if (alive.current) setResult(text);
      },
      () => stopped.current,
    );

    if (turn.calls.length) throw Error("Unexpected tool call");
    if (!alive.current) return;
    setResult(turn.content);
    setAsked([...messages, { role: "assistant", content: turn.content }]);
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
      if (alive.current && !stopped.current) setError(String(problem));
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
    void stopRun(active.current);
  }

  return { ready, result, asked, busy, error, setError, ask, retry, stop };
}

export type InlineRun = ReturnType<typeof useInlineRun>;
