import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { useRecorder } from "./audio";

export interface CaptureProps {
  book: Notebook;
  books: [string, string][];
  shared: string[];
  voice?: boolean;
  photo?: File;
  mobile: boolean;
  t: T;
  close: () => void;
  saved: (space: string, id: string, notice?: string) => void;
}

export interface Draft {
  text: string;
  spoken: number | null;
}

export type RecorderControls = ReturnType<typeof useRecorder>;

const MAX_CLIP_ADDRESS = 2048;
const WEB_ADDRESS = /^https:\/\/\S+$/i;

export function webAddress(text: string) {
  const trimmed = text.trim();

  return WEB_ADDRESS.test(trimmed) && trimmed.length <= MAX_CLIP_ADDRESS;
}
