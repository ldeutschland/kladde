import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { command } from "../platform/native";
import { recordFile } from "../files/attachments";
import type { Entry, Notebook } from "../notebook/notebook";

export type RecorderPhase =
  "idle" | "starting" | "recording" | "paused" | "finishing";

export interface RecorderState {
  phase: RecorderPhase;
  seconds: number;
  level: number;
  settled: string;
  pending: string;
  model: boolean;
  error: string;
}

export interface Recording {
  seconds: number;
  text: string;
  transcribed: boolean;
  reason: string;
}

interface SavedRecording {
  parts: string[];
  size: number;
}

const AUDIO_TYPE = "audio/mp4";
const BROWSER_EVENT = "kladde-audio";
const FALLBACK_LANGUAGES = ["de-DE", "en-US"];
const LANGUAGE = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;
const IDLE: RecorderState = {
  phase: "idle",
  seconds: 0,
  level: 0,
  settled: "",
  pending: "",
  model: false,
  error: "",
};

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function amount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function recorderReducer(
  state: RecorderState,
  event: Record<string, unknown>,
): RecorderState {
  switch (event.kind) {
    case "state": {
      const phase = text(event.state);

      if (phase !== "recording" && phase !== "paused" && phase !== "finishing")
        return state;

      return { ...state, phase, model: false };
    }
    case "level":
      return {
        ...state,
        phase: state.phase === "starting" ? "recording" : state.phase,
        seconds: amount(event.seconds),
        level: Math.max(0, Math.min(1, amount(event.level))),
      };
    case "text":
      return {
        ...state,
        settled: text(event.settled),
        pending: text(event.pending),
        model: false,
      };
    case "model":
      return { ...state, model: true };
    case "failed":
      return { ...IDLE, error: text(event.reason) || "failed" };
    case "done":
      return IDLE;
    default:
      return state;
  }
}

function subscribe(handle: (event: Record<string, unknown>) => void) {
  if (!isTauri()) {
    const receive = (event: Event) =>
      handle((event as CustomEvent<Record<string, unknown>>).detail);

    window.addEventListener(BROWSER_EVENT, receive);

    return () => window.removeEventListener(BROWSER_EVENT, receive);
  }

  let live = true;
  const attached = listen<Record<string, unknown>>("audio", (event) => {
    if (live) handle(event.payload);
  });

  return () => {
    live = false;
    void attached.then((stop) => stop());
  };
}

export function useRecorder() {
  const [state, setState] = useState(IDLE);
  const active = useRef(false);

  useEffect(
    () => subscribe((event) => setState((s) => recorderReducer(s, event))),
    [],
  );
  useEffect(
    () => () => {
      if (active.current) void command("audio_discard").catch(() => {});
    },
    [],
  );
  const start = useCallback(async (language: string) => {
    setState({ ...IDLE, phase: "starting" });

    try {
      await command("audio_start", { language });
      active.current = true;
    } catch (problem) {
      setState({ ...IDLE, error: String(problem) });
    }
  }, []);
  const stop = useCallback(async (language: string) => {
    setState((s) => ({ ...s, phase: "finishing" }));

    try {
      return await command<Recording>("audio_stop", { language });
    } catch (problem) {
      active.current = false;
      setState({ ...IDLE, error: String(problem) });
      throw problem;
    }
  }, []);
  const discard = useCallback(async () => {
    active.current = false;
    setState(IDLE);
    await command("audio_discard").catch(() => {});
  }, []);
  const save = useCallback(
    async (book: Notebook, entry: Entry, name: string) => {
      await book.flush();
      const saved = await command<SavedRecording>("audio_save", {
        space: book.id,
        doc: entry.id,
      });

      active.current = false;
      const id = recordFile(entry, saved.parts, {
        type: AUDIO_TYPE,
        name,
        size: saved.size,
      });

      return "kladde-file:" + id;
    },
    [],
  );

  return {
    state,
    start,
    stop,
    discard,
    save,
    pause: () => void command("audio_pause"),
    resume: () => void command("audio_resume"),
  };
}

export function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = String(whole % 60).padStart(2, "0");

  if (minutes < 60) return `${minutes}:${rest}`;
  const hours = Math.floor(minutes / 60);

  return `${hours}:${String(minutes % 60).padStart(2, "0")}:${rest}`;
}

export function recordingName(label: string, lang: string, at = new Date()) {
  const stamp = at.toLocaleString(lang, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${label} ${stamp}.m4a`.replace(/[/:]/g, "-");
}

export function defaultLanguage(book: Notebook, lang: string) {
  const stored = book.settings.get("audioLanguage");

  if (typeof stored === "string" && LANGUAGE.test(stored)) return stored;

  return lang === "en" ? "en-US" : "de-DE";
}

export async function recordingLanguages() {
  try {
    const listed = await command<string[]>("audio_languages");
    const valid = listed.filter((id) => LANGUAGE.test(id));

    return valid.length ? valid : FALLBACK_LANGUAGES;
  } catch {
    return FALLBACK_LANGUAGES;
  }
}

export function languageName(id: string, lang: string) {
  try {
    const names = new Intl.DisplayNames([lang], { type: "language" });

    return names.of(id) ?? id;
  } catch {
    return id;
  }
}

export function shortLanguageName(id: string, lang: string, ids: string[]) {
  const [base, ...rest] = id.split("-");
  const region = rest.at(-1);
  const name = languageName(base, lang);
  const variants = ids.filter((other) => other.split("-")[0] === base);

  if (variants.length < 2 || !region) return name;

  return `${name} (${region})`;
}

export function transcriptBlocks(transcript: string) {
  return transcript
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((content) => ({ type: "paragraph" as const, content }));
}

export function transcribeStored(
  book: Notebook,
  entry: Entry,
  id: string,
  name: string,
  language: string,
) {
  return command<Recording>("audio_transcribe", {
    file: { space: book.id, doc: entry.id, id, name, language },
  });
}

export function failureWord(reason: string) {
  if (reason === "microphone") return "recordNoMicrophone" as const;
  if (reason === "input") return "recordNoInput" as const;
  if (reason.includes("Native application")) return "recordNative" as const;

  return "recordFailed" as const;
}
