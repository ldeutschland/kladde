import { command } from "../platform/native";
import type { Entry, Notebook, Stored } from "../notebook/notebook";

export type Cause = "change" | "ai" | "restore" | "file";
export interface Version {
  rev: number;
  time: number;
  label: string | null;
  cause: Cause | null;
  file?: string;
  foreign?: true;
}
export interface Shares {
  own: {
    file: string;
    time: number;
    label: string | null;
    cause: string | null;
  }[];
  gone: string[];
}
export interface VersionDay {
  day: number;
  versions: Version[];
}

export const MAX_LABEL_CHARS = 80;
const LISTED_MAP = "versions";
const SHARED_KINDS: ReadonlySet<string> = new Set(["page", "row", "database"]);
const CAUSES: ReadonlySet<string> = new Set([
  "change",
  "ai",
  "restore",
  "file",
]);
const FILE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHARE_DELAY_MS = 4000;
const SHARE_BATCH = 8;
const FOREIGN_REV = 0;
const MAX_FOREIGN = 500;
const SECOND_MS = 1000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;

export function listVersions(id: string) {
  return command<Version[]>("versions", { id });
}
export function loadVersion(id: string, rev: number) {
  return command<Stored>("version", { id, rev });
}
export function keepVersion(
  id: string,
  label: string | null = null,
  cause: Cause | null = null,
) {
  return command<number>("keep_version", { id, label, cause });
}
export async function keepBefore(book: Notebook, entry: Entry, cause: Cause) {
  await book.flush();
  if (entry.rev) await keepVersion(entry.id, null, cause);
}
export function labelVersion(id: string, rev: number, label: string | null) {
  return command<void>("label_version", { id, rev, label });
}
export function deleteVersion(id: string, rev: number) {
  return command<void>("delete_version", { id, rev });
}

export function cleanLabel(text: string) {
  const printable = text.replace(/\p{Cc}/gu, " ").trim();

  return Array.from(printable).slice(0, MAX_LABEL_CHARS).join("").trim();
}

export function versionKey(version: Version) {
  return version.foreign ? "file:" + version.file : "rev:" + version.rev;
}

function listedTime(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function listedVersion(file: string, value: unknown): Version | null {
  if (!FILE_ID.test(file) || !value || typeof value !== "object") return null;
  const { time, label, cause } = value as Record<string, unknown>;
  const kept = listedTime(time);

  if (kept === null) return null;

  return {
    rev: FOREIGN_REV,
    time: kept,
    label: (typeof label === "string" && cleanLabel(label)) || null,
    cause: CAUSES.has(String(cause)) ? (cause as Cause) : null,
    file,
    foreign: true,
  };
}

export function allVersions(local: Version[], entry: Entry) {
  const own = new Set(local.map((version) => version.file));
  const foreign: Version[] = [];

  for (const [file, value] of entry.doc.getMap(LISTED_MAP)) {
    const listed = own.has(file) ? null : listedVersion(file, value);

    if (listed) foreign.push(listed);
  }

  const newest = foreign.sort((a, b) => b.time - a.time).slice(0, MAX_FOREIGN);

  return [...local, ...newest].sort((a, b) => b.time - a.time);
}

function sameEntry(known: unknown, own: Shares["own"][number]) {
  if (!known || typeof known !== "object") return false;
  const { time, label, cause } = known as Record<string, unknown>;

  return time === own.time && label === own.label && cause === own.cause;
}

export function applyShares(entry: Entry, shares: Shares) {
  const listed = entry.doc.getMap(LISTED_MAP);

  entry.doc.transact(() => {
    for (const file of shares.gone) listed.delete(file);

    for (const own of shares.own) {
      if (!FILE_ID.test(own.file) || sameEntry(listed.get(own.file), own))
        continue;
      const { time, label, cause } = own;

      listed.set(own.file, { time, label, cause });
    }
  });
}

export async function shareVersions(book: Notebook, entry: Entry) {
  if (!SHARED_KINDS.has(entry.kind)) return;
  await book.flush();
  if (!entry.rev) return;
  const shares = await command<Shares>("share_versions", {
    space: book.id,
    doc: entry.id,
  });

  if (Array.isArray(shares?.own) && Array.isArray(shares.gone))
    applyShares(entry, shares);
}

const waiting = new Map<string, ReturnType<typeof setTimeout>>();

export function shareLater(book: Notebook, entries: Entry[]) {
  if (entries.length > SHARE_BATCH) return;

  for (const entry of entries) {
    if (!SHARED_KINDS.has(entry.kind)) continue;
    clearTimeout(waiting.get(entry.id));

    const share = () => {
      waiting.delete(entry.id);
      void shareVersions(book, entry).catch(() => {});
    };

    waiting.set(entry.id, setTimeout(share, SHARE_DELAY_MS));
  }
}

export function loadShared(book: Notebook, entry: Entry, file: string) {
  return command<Stored>("shared_version", {
    space: book.id,
    doc: entry.id,
    file,
  });
}

export async function dropShared(book: Notebook, entry: Entry, file: string) {
  await book.flush();
  const proven = { space: book.id, doc: entry.id, file };

  await command("drop_shared_version", proven).catch(() => {});
  entry.doc.getMap(LISTED_MAP).delete(file);
}

function startOfDay(time: number) {
  const date = new Date(time);

  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

export function byDay(versions: Version[]): VersionDay[] {
  const days: VersionDay[] = [];

  for (const version of versions) {
    const day = startOfDay(version.time * SECOND_MS);
    const last = days.at(-1);

    if (last?.day === day) last.versions.push(version);
    else days.push({ day, versions: [version] });
  }

  return days;
}

export function dayTitle(day: number, now: number, lang: string) {
  const elapsed = Math.round((startOfDay(now) - day) / DAY_MS);

  if (elapsed === 0 || elapsed === 1) {
    const relative = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
    const words = relative.format(-elapsed, "day");

    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  const sameYear = new Date(day).getFullYear() === new Date(now).getFullYear();

  return new Date(day).toLocaleDateString(lang, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: sameYear ? undefined : "numeric",
  });
}

export function timeOfDay(version: Version, lang: string) {
  return new Date(version.time * SECOND_MS).toLocaleTimeString(lang, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fullTime(version: Version, lang: string) {
  return new Date(version.time * SECOND_MS).toLocaleString(lang, {
    dateStyle: "long",
    timeStyle: "short",
  });
}
