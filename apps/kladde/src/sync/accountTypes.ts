import type { Dispatch, SetStateAction } from "react";
import type { Notebook } from "../notebook/notebook";
import type { Ask } from "../ui/dialog";
import type { T, Word } from "../locale/locale";
import {
  SYNC_OFF,
  statusFromError,
  syncDetails,
  type SyncStatus,
} from "./sync";

export const ACTION_WORDS = {
  login: "login",
  register: "register",
  change: "changePassword",
  recover: "resetPassword",
  revoke: "removeDevice",
  renew: "signInAgain",
} as const satisfies Record<string, Word>;

export type SyncAction = keyof typeof ACTION_WORDS;

export type AccountInfo = [
  origin: string,
  user: string,
  space: string,
  device: string,
];

export type RecoveryPhrase = [words: string, first: number, second: number];

export interface SyncPanelProps {
  book: Notebook;
  ask: Ask;
  t: T;
  status: SyncStatus;
  setStatus: Dispatch<SetStateAction<SyncStatus>>;
  changeBook: (id?: string) => Promise<void>;
  reloadBooks: () => Promise<void>;
}

const SYNC_ERROR = /^(Error: )?sync:/;

export function signsIn(action: SyncAction) {
  return action === "login" || action === "renew";
}

export function readableError(error: unknown, t: T) {
  const text = String(error);

  if (!SYNC_ERROR.test(text)) return text;

  return syncDetails(statusFromError(error, SYNC_OFF), t, String)[0] ?? text;
}
