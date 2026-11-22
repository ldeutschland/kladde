import { useEffect, useRef, useState } from "react";
import {
  defaultLanguage,
  recordingLanguages,
  type Recording,
  type RecorderState,
  type useRecorder,
} from "./audio";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";

export const BARS = 44;

export interface SessionOptions {
  recorder: ReturnType<typeof useRecorder>;
  book: Notebook;
  lang: string;
  t: T;
  submit: (result: Recording, keep: boolean) => Promise<void>;
  close: () => void;
  discarded: () => void;
}

function useLevels(state: RecorderState) {
  const [levels, setLevels] = useState<number[]>([]);

  useEffect(() => {
    if (state.phase === "idle" || state.phase === "starting") {
      setLevels([]);

      return;
    }

    if (state.phase !== "recording") return;
    setLevels((known) => [...known, state.level].slice(-BARS));
  }, [state.phase, state.level, state.seconds]);

  return levels;
}

function useRecordingLanguage(book: Notebook, lang: string) {
  const [language, setLanguage] = useState(() => defaultLanguage(book, lang));
  const [languages, setLanguages] = useState([language]);

  useEffect(() => {
    void recordingLanguages().then((listed) =>
      setLanguages(listed.includes(language) ? listed : [language, ...listed]),
    );
  }, [language]);

  function choose(next: string) {
    setLanguage(next);
    book.settings.set("audioLanguage", next);
  }

  return { language, languages, choose };
}

function useKeepAudio(book: Notebook) {
  const [keep, setKeep] = useState(book.settings.get("audioKeep") !== false);

  function toggleKeep() {
    book.settings.set("audioKeep", !keep);
    setKeep(!keep);
  }

  return { keep, toggleKeep };
}

function useFirstStart(
  start: (language: string) => Promise<void>,
  language: string,
) {
  const [started, setStarted] = useState(language);
  const begun = useRef(false);

  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    void start(started);
  }, [start, started]);

  return { started, setStarted };
}

export function useRecordingSession(options: SessionOptions) {
  const { recorder, book, lang, t, submit, close, discarded } = options;
  const { state, start } = recorder;
  const levels = useLevels(state);
  const choice = useRecordingLanguage(book, lang);
  const { language } = choice;
  const { started, setStarted } = useFirstStart(start, language);
  const { keep, toggleKeep } = useKeepAudio(book);
  const [saving, setSaving] = useState(false);
  const [storing, setStoring] = useState(false);
  const [problem, setProblem] = useState("");
  const live = state.phase === "recording" || state.phase === "paused";
  const busy = saving || state.phase === "finishing";

  async function restart() {
    setProblem("");
    setStarted(language);
    await start(language);
  }

  async function cancel() {
    if (storing) return;
    await recorder.discard();
    discarded();
  }

  async function finish() {
    if (!live || busy) return;
    setSaving(true);
    setProblem("");

    try {
      const result = await recorder.stop(language);

      setStoring(true);
      await submit(result, keep);
      close();
    } catch (failure) {
      setProblem(t("recordFailed").replace("{error}", String(failure)));
      setSaving(false);
      setStoring(false);
    }
  }

  return {
    ...choice,
    levels,
    started,
    keep,
    toggleKeep,
    saving,
    storing,
    problem,
    live,
    busy,
    restart,
    cancel,
    finish,
  };
}
