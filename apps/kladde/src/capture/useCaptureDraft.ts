import { useState } from "react";
import { webAddress, type CaptureProps, type Draft } from "./types";

export function useCaptureDraft({ photo, voice = false }: CaptureProps) {
  const [text, setText] = useState(""),
    [file, setFile] = useState<File | undefined>(photo),
    [clip, setClip] = useState(false),
    [recording, setRecording] = useState(voice),
    [spoken, setSpoken] = useState<number | null>(null),
    [error, fail] = useState(""),
    [focused, setFocused] = useState(false);
  const clips = (draft: Draft) =>
    !file && draft.spoken === null && clip && webAddress(draft.text);

  return {
    text,
    setText,
    file,
    setFile,
    clip,
    setClip,
    recording,
    setRecording,
    spoken,
    setSpoken,
    error,
    fail,
    focused,
    setFocused,
    clips,
    url: webAddress(text),
    clipping: clips({ text, spoken }),
    content: !!text.trim() || !!file || spoken !== null,
  };
}

export type CaptureDraft = ReturnType<typeof useCaptureDraft>;
