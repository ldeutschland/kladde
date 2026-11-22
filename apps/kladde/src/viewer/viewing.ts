import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";

export type ViewKind = "image" | "pdf";

export interface ViewTarget {
  block: string;
  url: string;
  name: string;
  kind: ViewKind;
  page?: number;
  edit?: boolean;
  found?: string;
}

export interface ViewerProps {
  book: Notebook;
  entry: Entry;
  target: ViewTarget;
  t: T;
  mobile: boolean;
  notify: (text: string) => void;
  place: (url: string, name: string, copy: boolean) => boolean;
  close: () => void;
}

const LOCAL_FILE = /^kladde-file:[0-9a-f-]{36}$/;
const SUFFIX = /\.[A-Za-z0-9]{1,5}$/;
const SUFFIXES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};
const MAX_NAME = 255;

export function isLocalFile(url: string) {
  return LOCAL_FILE.test(url);
}

export function fileId(url: string) {
  return url.slice("kladde-file:".length);
}

export function savedName(name: string, type: string, copy: boolean, t: T) {
  const suffix = SUFFIXES[type] ?? "";
  const known = SUFFIX.exec(name)?.[0] ?? "";
  const keeps =
    known.toLowerCase() === suffix ||
    (suffix === ".jpg" && /^\.jpe?g$/i.test(known));
  const base = (name || t("file")).replace(SUFFIX, "");
  const label = copy ? `${base} (${t("editedCopy")})` : base;

  return (label + (keeps ? known : suffix)).slice(-MAX_NAME);
}
