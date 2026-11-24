import * as Y from "yjs";
import { command } from "../platform/native";
import {
  freshPage,
  loadState,
  type Notebook,
  type Stored,
} from "../notebook/notebook";
import type { T, Word } from "../locale/locale";
import { type RowPage, type StoredRow } from "../database/rowIndex";

export type SyncPhase =
  "off" | "syncing" | "synced" | "offline" | "auth" | "outdated" | "error";
export type SyncProblem =
  | "offline"
  | "busy"
  | "auth"
  | "denied"
  | "integrity"
  | "unconfirmed"
  | "storage"
  | "address"
  | "files"
  | "full"
  | "outdated_app"
  | "outdated_server"
  | "unknown";
export type SyncBehind = "server" | "device";
export interface SyncReport {
  changed: string[];
  removed: string[];
  rescue: string[];
  failed: string[];
  retry?: string[];
  newer?: string[];
  behind?: string[] | null;
  waiting: number;
  stopped: string | null;
}
export interface SyncResult extends SyncReport {
  recovered: string[];
}
export interface SyncRequest {
  full: boolean;
  hints: [string, number][];
}
export interface SyncStatus {
  phase: SyncPhase;
  at: number | null;
  problem: SyncProblem | null;
  detail: string;
  failed: string[];
  waiting: number;
  files: SyncProblem | null;
  newer: string[];
  behind: SyncBehind[];
}

export const SYNC_OFF: SyncStatus = {
  phase: "off",
  at: null,
  problem: null,
  detail: "",
  failed: [],
  waiting: 0,
  files: null,
  newer: [],
  behind: [],
};

export const FULL_SYNC: SyncRequest = { full: true, hints: [] };

const PROBLEMS: SyncProblem[] = [
  "offline",
  "busy",
  "auth",
  "denied",
  "integrity",
  "unconfirmed",
  "storage",
  "address",
  "files",
  "full",
  "outdated_app",
  "outdated_server",
];
const PROBLEM_TEXT: Record<SyncProblem, Word> = {
  offline: "syncOfflineDetail",
  busy: "syncBusyDetail",
  auth: "syncAuthDetail",
  denied: "syncDeniedDetail",
  integrity: "syncIntegrityDetail",
  unconfirmed: "syncUnconfirmedDetail",
  storage: "syncStorageDetail",
  address: "syncAddressDetail",
  files: "syncFilesDetail",
  full: "syncFullDetail",
  outdated_app: "syncOutdatedAppDetail",
  outdated_server: "syncOutdatedServerDetail",
  unknown: "syncUnknownDetail",
};
const BEHIND_TEXT: Record<SyncBehind, Word> = {
  server: "syncServerBehindNotice",
  device: "syncDeviceBehindNotice",
};
const PHASE_TEXT: Record<SyncPhase, Word> = {
  off: "unsynced",
  syncing: "syncing",
  synced: "synced",
  offline: "syncOffline",
  auth: "syncAuth",
  outdated: "syncOutdated",
  error: "syncProblem",
};
const LOCKED = "Notebook locked";
const TRANSIENT = new Set<SyncProblem>(["offline", "busy", "storage"]);
const GRACE_FAILURES = 2;
const RETRY_MS = [2000, 5000, 15000, 30000, 60000];
const BUSY_RETRY_MS = 30000;

function problemOf(code: string): SyncProblem {
  const known = PROBLEMS.find((problem) => problem === code);

  return known ?? "unknown";
}

function phaseOf(problem: SyncProblem): SyncPhase {
  if (problem === "offline" || problem === "busy") return "offline";
  if (problem === "auth") return "auth";
  if (problem === "outdated_app" || problem === "outdated_server")
    return "outdated";

  return "error";
}

function behindOf(report: SyncReport, previous: SyncStatus): SyncBehind[] {
  if (!report.behind) return previous.behind;
  const known = report.behind.filter((side): side is SyncBehind =>
    Object.hasOwn(BEHIND_TEXT, side),
  );

  return [...new Set(known)];
}

function newerOf(report: SyncReport, previous: SyncStatus): string[] {
  const stillFailing = previous.newer.filter((id) =>
    report.failed.includes(id),
  );

  return [...new Set([...(report.newer ?? []), ...stillFailing])];
}

export function statusFromReport(
  report: SyncReport,
  previous: SyncStatus,
  now = Date.now(),
): SyncStatus {
  const problem = report.stopped ? problemOf(report.stopped) : null;
  const failed = report.failed.length > 0;

  return {
    phase: problem ? phaseOf(problem) : failed ? "error" : "synced",
    at: problem && problem !== "files" ? previous.at : now,
    problem,
    detail: "",
    failed: report.failed,
    waiting: report.waiting,
    files: previous.files,
    newer: newerOf(report, previous),
    behind: behindOf(report, previous),
  };
}

export function needsRepair(status: SyncStatus) {
  if (status.problem === "full") return false;

  return status.failed.some((id) => !status.newer.includes(id));
}

export function withFiles(status: SyncStatus): SyncStatus {
  if (!status.files || status.phase !== "synced") return status;

  return { ...status, phase: "error", problem: status.files };
}

export function statusFromError(
  error: unknown,
  previous: SyncStatus,
): SyncStatus {
  const text = String(error).replace(/^Error: /, "");
  const code = text.startsWith("sync:") ? text.slice(5) : "";
  const problem = text.includes(LOCKED) ? "storage" : problemOf(code);

  return {
    ...previous,
    phase: phaseOf(problem),
    problem,
    detail: problem === "unknown" ? text : "",
  };
}

export function settle(
  next: SyncStatus,
  previous: SyncStatus,
  failures: number,
): SyncStatus {
  if (!next.problem || !TRANSIENT.has(next.problem)) return next;
  if (failures >= GRACE_FAILURES) return next;

  return { ...previous, waiting: next.waiting };
}

export function retryDelay(
  failures: number,
  problem: SyncProblem | null,
  random = Math.random,
) {
  const step = Math.min(Math.max(failures, 1), RETRY_MS.length) - 1;
  const base =
    problem === "busy"
      ? Math.max(RETRY_MS[step], BUSY_RETRY_MS)
      : RETRY_MS[step];

  return Math.round(base * (1 + random() / 4));
}

export function syncLabel(status: SyncStatus, t: T) {
  return t(PHASE_TEXT[status.phase]);
}

function clock(at: number) {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function syncDetails(
  status: SyncStatus,
  t: T,
  titleOf: (id: string) => string,
) {
  const lines: string[] = [];

  if (status.problem) lines.push(t(PROBLEM_TEXT[status.problem]));
  if (status.detail) lines.push(status.detail);
  for (const side of status.behind) lines.push(t(BEHIND_TEXT[side]));
  if (status.newer.length) lines.push(t("syncNewerNotice"));
  if (status.failed.length)
    lines.push(
      t("syncFailed")
        .replace("{n}", String(status.failed.length))
        .replace("{titles}", status.failed.slice(0, 5).map(titleOf).join(", ")),
    );
  if (status.waiting)
    lines.push(t("syncWaiting").replace("{n}", String(status.waiting)));
  if (status.phase !== "off")
    lines.push(
      status.at
        ? t("syncLast").replace("{time}", clock(status.at))
        : t("syncNever"),
    );

  return lines;
}

const NOT_COPIED = new Set(["workspace", "chat", "index"]);
const MAX_TITLE = 200;

type Known = Pick<Stored, "space" | "kind" | "title" | "parent">;

function draftOf(book: Notebook, id: string): Known | null {
  const entry = book.entries.get(id);

  if (!entry) return null;
  const title = entry.doc.getMap("meta").get("title");

  return {
    space: book.id,
    kind: entry.kind,
    title: typeof title === "string" ? title : "",
    parent: null,
  };
}

async function relist(book: Notebook, id: string, rescued: Set<string>) {
  const listed = book.pages.get(id);

  if (listed) {
    if (listed.archived) book.pages.set(id, { ...listed, archived: null });

    return true;
  }

  const stored = await command<Stored | null>("load", { id });
  const known = stored ?? draftOf(book, id);

  if (!known || known.space !== book.id || NOT_COPIED.has(known.kind))
    return false;
  const parent =
    known.parent && (book.pages.has(known.parent) || rescued.has(known.parent))
      ? known.parent
      : null;

  book.pages.set(
    id,
    freshPage(id, known.title.slice(0, MAX_TITLE), known.kind, parent),
  );

  return true;
}

async function relistRows(book: Notebook, database: string) {
  await book.pages.rowsOf(database);
  let after: number | null = 0;

  while (after !== null) {
    const [rows, next]: RowPage<StoredRow> = await command("rows", {
      space: book.id,
      parent: database,
      after,
    });
    const missing = rows.filter(([id]) => !book.pages.has(id));

    book.pages.setAll(
      missing.map(([id, title]) =>
        freshPage(id, title.slice(0, MAX_TITLE), "row", database),
      ),
    );
    after = next;
  }
}

function retire(
  book: Notebook,
  originals: string[],
  rescued: Set<string>,
  gone: Set<string>,
) {
  return book.erase(originals, async (id) => {
    if (gone.has(id)) return;
    if (rescued.has(id))
      return command("discard_rescued", { space: book.id, id });

    return command("forget", { id });
  });
}

export function rescueMark(device: string, original: string) {
  return device + "/" + original;
}

function hasCopy(book: Notebook, mark: string) {
  for (const page of book.pages.values())
    if (page.rescued === mark && !page.archived) return true;

  return false;
}

export async function deviceOf(space: string) {
  const account = await command<string[] | null>("account_info", { space });
  const device = account?.[3];

  if (typeof device !== "string" || !device) throw Error("Device unknown");

  return device;
}

async function finishCopied(
  book: Notebook,
  ids: string[],
  rescued: Set<string>,
  gone: Set<string>,
  device: string,
) {
  const titles: string[] = [];

  for (const id of ids) {
    const page = book.pages.get(id);

    if (!page || !hasCopy(book, rescueMark(device, id))) continue;
    await retire(book, book.branch(id), rescued, gone);
    titles.push(page.title);
  }

  return titles;
}

async function rescue(book: Notebook, ids: string[], gone: Set<string>) {
  const device = await deviceOf(book.id);
  const rescued = new Set(ids);
  const titles = await finishCopied(book, ids, rescued, gone, device);
  const copyable: string[] = [];

  for (const id of ids) if (await relist(book, id, rescued)) copyable.push(id);
  for (const id of copyable)
    if (book.pages.get(id)?.kind === "database") await relistRows(book, id);
  const roots = copyable.filter(
    (id) => !rescued.has(book.pages.get(id)?.parent ?? ""),
  );
  const { copyPages } = await import("../notebook/copyPages");

  for (const root of roots) {
    const title = book.pages.get(root)?.title ?? "";
    const mark = rescueMark(device, root);

    if (!hasCopy(book, mark)) {
      const copy = await copyPages(book, book, root, true, mark);

      await book.change(copy, { title });
    }

    await retire(book, book.branch(root), rescued, gone);
    titles.push(title);
  }

  await book.flush();

  return titles;
}

export async function applyRemote(book: Notebook, id: string) {
  const entry = book.entries.get(id);

  if (!entry) return book.pages.adopt(id);
  const stored = await loadState(id, book.id, entry.kind, entry.rev);

  if (!stored?.data) return;
  entry.rev = Math.max(entry.rev, stored.rev);
  Y.applyUpdate(entry.doc, stored.data, "remote");
}

async function applyReport(book: Notebook, report: SyncReport) {
  for (const id of report.changed) await applyRemote(book, id);
  const drafts = report.removed.filter((id) => book.dirty.has(id));

  for (const id of report.removed) {
    if (drafts.includes(id)) book.dirty.delete(id);
    else book.release(id);
  }

  return drafts;
}

export async function syncBook(
  book: Notebook,
  space = book.id,
  request: SyncRequest = FULL_SYNC,
): Promise<SyncResult> {
  await book.flush().catch(() => {});
  const report = await command<SyncReport>("sync_now", {
    space,
    full: request.full,
    hints: request.hints,
  });
  const own = space === book.id;
  const drafts = own ? await applyReport(book, report) : [];
  const rescued = [...report.rescue, ...drafts];
  const gone = new Set(report.removed);
  const recovered =
    own && rescued.length ? await rescue(book, rescued, gone) : [];

  if (own && request.full && !report.stopped) await book.pages.settle();
  book.notify();

  return { ...report, recovered };
}
