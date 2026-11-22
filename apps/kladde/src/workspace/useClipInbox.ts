import { useEffect, useRef, type RefObject } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { command } from "../platform/native";
import type { Ask } from "../ui/dialog";
import type { Toast } from "./types";

const CLIP_INBOX_MS = 3000;
const CLIP_RETRY_MS = 60000;

interface ClipPreview {
  kind: string;
  title: string;
  url: string;
  confirm: boolean;
}

interface Inbox {
  book: Notebook;
  t: T;
  ask: Ask;
  retries: Map<string, number>;
  receiving: RefObject<boolean>;
  live: () => boolean;
  toast: (toast: Toast) => void;
  open: (rowId: string) => void;
}

function failureReason(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error: /, "")
    .replace(/^retry:/, "");
}

async function reportFailure(inbox: Inbox, id: string, error: unknown) {
  const reason = failureReason(error);
  const waiting = await command<string[]>("clip_inbox").catch(() => [id]);
  const again = waiting.includes(id);
  const first = !inbox.retries.has(id);

  if (again) inbox.retries.set(id, Date.now() + CLIP_RETRY_MS);
  if (!inbox.live() || (again && !first)) return;
  inbox.toast({
    text: inbox
      .t(again ? "clipRetry" : "clipFailed")
      .replace("{error}", reason),
  });
}

export async function approveClip(inbox: Pick<Inbox, "t" | "ask">, id: string) {
  const preview = await command<ClipPreview>("clip_inbox_preview", { id });

  if (!preview.confirm) return true;
  const detail = inbox
    .t("clipConfirmDetail")
    .replace("{title}", preview.title || preview.url)
    .replace("{url}", preview.url);
  const answer = await inbox.ask(inbox.t("clipConfirm"), undefined, {
    detail,
    action: inbox.t("apply"),
  });

  if (answer !== null) return true;
  await command("finish_clip_inbox_item", { id });

  return false;
}

async function receiveClip(inbox: Inbox, id: string) {
  const { book, t } = inbox;

  try {
    if (!(await approveClip(inbox, id))) return;
    const { importInboxItem } = await import("../capture/clipper");
    const row = await importInboxItem(book, id, t);

    inbox.retries.delete(id);
    const title = book.pages.get(row.id)?.title || t("webClip");

    if (inbox.live())
      inbox.toast({
        text: t("clipReceived").replace("{title}", title),
        open: () => inbox.open(row.id),
      });
  } catch (error) {
    await reportFailure(inbox, id, error);
  }
}

async function checkInbox(inbox: Inbox) {
  if (inbox.receiving.current || document.hidden) return;
  inbox.receiving.current = true;
  const due = (id: string) => (inbox.retries.get(id) ?? 0) <= Date.now();

  try {
    const waiting = await command<string[]>("clip_inbox");

    for (const id of waiting)
      if (inbox.live() && due(id)) await receiveClip(inbox, id);
  } catch {
    return;
  } finally {
    inbox.receiving.current = false;
  }
}

function watchInbox(inbox: Inbox) {
  const check = () => void checkInbox(inbox);

  check();
  const timer = window.setInterval(check, CLIP_INBOX_MS);

  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", check);

  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", check);
    document.removeEventListener("visibilitychange", check);
  };
}

export function useClipInbox(
  book: Notebook,
  t: T,
  ask: Ask,
  toast: (toast: Toast) => void,
  openRow: (rowId: string) => void,
) {
  const receiving = useRef(false),
    retries = useRef(new Map<string, number>()),
    openClip = useRef(openRow),
    asking = useRef(ask);

  openClip.current = openRow;
  asking.current = ask;
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    const stop = watchInbox({
      book,
      t,
      ask: (...question) => asking.current(...question),
      retries: retries.current,
      receiving,
      live: () => live,
      toast,
      open: (rowId) => openClip.current(rowId),
    });

    return () => {
      live = false;
      stop();
    };
  }, [book, t, toast]);
}
