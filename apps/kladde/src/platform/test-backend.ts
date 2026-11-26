import * as Y from "yjs";
import { contentHash } from "../files/attachments";
import type { Stored } from "../notebook/notebook";

interface SimulatedSync {
  error?: string;
  report?: Record<string, unknown>;
}

function simulatedSync(): SimulatedSync | null {
  return JSON.parse(localStorage.getItem("kladde-test-sync") ?? "null");
}

interface SimulatedBooks {
  remote: string[];
  excluded: string[];
  titles: Record<string, string>;
  primary: string;
}

const SYNC_BOOKS = "kladde-test-sync-books";

function simulatedBooks(): SimulatedBooks {
  const stored = JSON.parse(localStorage.getItem(SYNC_BOOKS) ?? "{}");

  return { remote: [], excluded: [], titles: {}, primary: "", ...stored };
}

function keepBooks(books: SimulatedBooks) {
  localStorage.setItem(SYNC_BOOKS, JSON.stringify(books));
}

function simulatedChoices(data: Record<string, Stored>) {
  const books = simulatedBooks();
  const local = Object.values(data).filter((n) => n.kind === "workspace");
  const here = new Set(local.map((n) => n.id));
  const choice = (id: string, title: string | null, isLocal: boolean) => ({
    id,
    title,
    local: isLocal,
    remote: books.remote.includes(id),
    excluded: books.excluded.includes(id),
    primary: books.primary === id,
  });

  return [
    ...local.map((n) => choice(n.id, n.title, true)),
    ...books.remote
      .filter((id) => !here.has(id))
      .map((id) => choice(id, books.titles[id] ?? null, false)),
  ];
}

function simulatedExclusion(space: string, excluded: boolean) {
  const books = simulatedBooks();

  books.excluded = books.excluded.filter((id) => id !== space);
  if (excluded) books.excluded.push(space);
  keepBooks(books);
}

function simulatedRemoval(space: string) {
  const books = simulatedBooks();

  books.remote = books.remote.filter((id) => id !== space);
  books.excluded = books.excluded.filter((id) => id !== space);
  keepBooks(books);
}

function simulatedDeletion(data: Record<string, Stored>, space: string) {
  const workspaces = Object.values(data).filter((n) => n.kind === "workspace");

  if (!workspaces.some((n) => n.id === space))
    throw Error("Workspace not on this device");
  if (workspaces.length < 2)
    throw Error("The last notebook on this device stays");
  for (const note of Object.values(data))
    if (note.space === space) delete data[note.id];
  localStorage.setItem("kladde-test-notes", JSON.stringify(data));
  const books = simulatedBooks();

  if (books.remote.includes(space) && !books.excluded.includes(space))
    books.excluded.push(space);
  keepBooks(books);
}

function simulatedLink(link: unknown) {
  const books = simulatedBooks();

  if (typeof link === "string" && !books.remote.includes(link))
    books.remote.push(link);
  keepBooks(books);

  return books.remote;
}

const OPENED_SPACE = "kladde-test-opened-space";
const SCRIPTED_CALLS = "kladde-test-ai-calls";
const ROW_PAGE = 5000;
const VERSIONS = "kladde-test-versions";
const STEADY_INTERVAL = "kladde-test-version-interval";
const PAUSE_SECONDS = 30;
const STEADY_SECONDS = 180;
const LARGE_LOSS = 200;
const LOSS_SHARE = 10;
const SHARE_FLOOR = 300;
const LARGE_GAIN = 2000;
const GAIN_SHARE = 2;
const GAIN_FLOOR = 400;
const WORTH_KEEPING = 100;
const SHARED = "kladde-test-shared-versions";
const SHARING = "kladde-test-share-versions";
const LISTED_MAP = "versions";
const MAX_LABEL_CHARS = 80;
const UNVERSIONED_KIND = "index";
const REQUESTED_CAUSES = ["ai", "restore", "file"];
const SINGLE_MAILBOX = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const INVALID = "Invalid notebook data";

interface SimulatedVersion {
  rev: number;
  time: number;
  label: string | null;
  cause: string | null;
  note: Stored;
  file?: string;
  listed?: boolean;
}
type Versions = Record<string, SimulatedVersion[]>;

const savedAt = new Map<string, number>();

function seconds() {
  return Math.floor(Date.now() / 1000);
}

function steadyInterval() {
  const stored = localStorage.getItem(STEADY_INTERVAL);

  return stored === null ? STEADY_SECONDS : Number(stored);
}

function lostLength(before: string, after: string) {
  const kept = new Map<string, number>();

  for (const word of after.split(/\s+/))
    kept.set(word, (kept.get(word) ?? 0) + 1);
  let lost = 0;

  for (const word of before.split(/\s+/)) {
    const left = kept.get(word) ?? 0;

    if (left) kept.set(word, left - 1);
    else lost += word.length;
  }

  return lost;
}

function losesMuch(before: string, after: string) {
  const share = Math.max(before.length, SHARE_FLOOR) / LOSS_SHARE;

  return lostLength(before, after) >= Math.min(LARGE_LOSS, share);
}

function gainsMuch(before: string, after: string) {
  if (before.trim().length < WORTH_KEEPING) return false;
  const half = before.length / GAIN_SHARE;
  const share = Math.min(LARGE_GAIN, Math.max(GAIN_FLOOR, half));

  return lostLength(after, before) >= share;
}

function capture(versions: Versions, previous: Stored, next: Stored) {
  if (previous.kind === UNVERSIONED_KIND) return;
  const kept = (versions[previous.id] ??= []);
  const now = seconds();
  const saved = savedAt.get(previous.id);
  const latest = Math.max(...kept.map((version) => version.time));
  const paused = saved === undefined || Math.abs(now - saved) >= PAUSE_SECONDS;
  const steady = Math.abs(now - latest) >= steadyInterval();
  const large =
    losesMuch(previous.body, next.body) || gainsMuch(previous.body, next.body);
  const known = kept.some((version) => version.rev === previous.rev);

  if (known || !(paused || steady || large)) return;
  const cause = large ? "change" : null;

  kept.push({
    rev: previous.rev,
    time: now,
    label: null,
    cause,
    note: previous,
  });
}

function checkedLabel(value: unknown) {
  if (value === null || value === undefined) return null;
  const label = String(value).trim();
  const length = Array.from(label).length;

  if (!length || length > MAX_LABEL_CHARS || /\p{Cc}/u.test(label))
    throw Error(INVALID);

  return label;
}

function checkedCause(value: unknown) {
  if (value === null || value === undefined) return null;
  if (!REQUESTED_CAUSES.includes(String(value))) throw Error(INVALID);

  return String(value);
}

function keepVersion(
  versions: Versions,
  note: Stored | undefined,
  args: Record<string, unknown>,
) {
  const label = checkedLabel(args.label);
  const cause = checkedCause(args.cause);

  if (!note) throw Error(INVALID);
  const kept = (versions[note.id] ??= []);
  const known = kept.find((version) => version.rev === note.rev);

  if (!known) kept.push({ rev: note.rev, time: seconds(), label, cause, note });
  if (known) known.label = label ?? known.label;
  if (known) known.cause = cause ?? known.cause;

  return note.rev;
}

function labelVersion(versions: Versions, args: Record<string, unknown>) {
  const label = checkedLabel(args.label);
  const kept = versions[String(args.id)] ?? [];
  const known = kept.find((version) => version.rev === args.rev);

  if (!known) throw Error(INVALID);
  known.label = label;
}

function listedVersions(versions: Versions, id: string) {
  return (versions[id] ?? [])
    .map(({ rev, time, label, cause, file }) => ({
      rev,
      time,
      label,
      cause,
      file,
    }))
    .sort((a, b) => b.rev - a.rev);
}

function sharedRecords(): Record<string, Stored> {
  return JSON.parse(localStorage.getItem(SHARED) ?? "{}");
}

function listedFiles(note: Stored | undefined) {
  const doc = new Y.Doc();

  if (note) Y.applyUpdate(doc, Uint8Array.from(note.data));

  return new Set(doc.getMap(LISTED_MAP).keys());
}

function isAnchor(version: SimulatedVersion) {
  return version.label !== null || version.cause !== null;
}

function shareVersions(versions: Versions, note: Stored | undefined) {
  const none = { own: [], gone: [] };

  if (!note || localStorage.getItem(SHARING) === null) return none;
  const listed = listedFiles(note);
  const records = sharedRecords();
  const kept = (versions[note.id] ?? []).filter(
    (version) => !version.file || !version.listed || listed.has(version.file),
  );

  for (const version of kept) {
    if (isAnchor(version) && !version.file) {
      version.file = crypto.randomUUID();
      records[version.file] = version.note;
    }

    if (version.file && listed.has(version.file)) version.listed = true;
  }

  versions[note.id] = kept;
  localStorage.setItem(SHARED, JSON.stringify(records));
  const shared = kept.filter((version) => version.file);

  return {
    own: shared
      .filter(isAnchor)
      .map(({ file, time, label, cause }) => ({ file, time, label, cause })),
    gone: shared
      .filter((version) => !isAnchor(version) && listed.has(version.file!))
      .map((version) => version.file),
  };
}

function sharedVersion(note: Stored | undefined, file: string) {
  const record = sharedRecords()[file];

  if (!note || !listedFiles(note).has(file)) throw Error(INVALID);
  if (!record) throw Error("Download failed");
  if (record.id !== note.id || record.kind !== note.kind) throw Error(INVALID);

  return record;
}

function dropShared(
  versions: Versions,
  note: Stored | undefined,
  file: string,
) {
  if (!note || !listedFiles(note).has(file)) throw Error(INVALID);
  const records = sharedRecords();

  delete records[file];
  localStorage.setItem(SHARED, JSON.stringify(records));
  versions[note.id] = (versions[note.id] ?? []).filter(
    (version) => version.file !== file,
  );
}

function storedVersion(versions: Versions, args: Record<string, unknown>) {
  const kept = versions[String(args.id)] ?? [];
  const known = kept.find((version) => version.rev === args.rev);

  if (!known) throw Error(INVALID);

  return known.note;
}

function fileNames(note: Stored) {
  const doc = new Y.Doc();

  Y.applyUpdate(doc, Uint8Array.from(note.data));
  const files = doc.getMap<{ name?: string }>("files");

  return Array.from(files, ([id, meta]) => ({ id, name: meta?.name ?? "" }));
}

const SIMULATED_SCAN = "Rechnung Nr. 4711\nBetrag: 120 Euro";
const SIMULATED_SCAN_BOX = [0.2, 0.4, 0.3, 0.12];

function simulatedScan(file: string) {
  const bytes = simulatedFiles.get(file);

  if (!bytes) return null;
  if (isSimulatedPdf(bytes)) return { page: 1, text: SIMULATED_SCAN };

  return simulatedPreview(file, 0) ? { page: 0, text: SIMULATED_SCAN } : null;
}

function simulatedReadable(body: string) {
  return body
    .replace(/<[^>]*>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function fileHit(
  note: Stored,
  file: { id: string; name: string },
  query: string,
) {
  const hit = { doc: note.id, file: file.id, name: file.name, offset: 0 };

  if (file.name.toLowerCase().includes(query))
    return { ...hit, snippet: "", page: 0, matched: "" };
  const scan = simulatedScan(file.id);
  const at = scan?.text.toLowerCase().indexOf(query) ?? -1;

  if (!scan || at < 0) return null;
  const matched = scan.text.slice(at, at + query.length);
  const snippet = scan.text.replace(/\s+/g, " ");

  return { ...hit, snippet, page: scan.page, matched, offset: at };
}

function fileHits(notes: Stored[], query: string) {
  return notes.flatMap((note) =>
    fileNames(note).flatMap((file) => fileHit(note, file, query) ?? []),
  );
}

function simulatedMatches(args: Record<string, unknown>) {
  const scan = simulatedScan(String(args.file));
  const term = String(args.term).toLowerCase();
  const text = scan?.text.toLowerCase() ?? "";
  const found = [];

  for (
    let at = text.indexOf(term);
    scan && at >= 0;
    at = text.indexOf(term, at + 1)
  ) {
    const top = Math.min(0.85, 0.2 + found.length * 0.12);

    found.push({ page: scan.page, boxes: [[0.2, top, 0.3, 0.08]] });
  }

  return found;
}

function simulatedFound(args: Record<string, unknown>) {
  const scan = simulatedScan(String(args.file));
  const term = String(args.term).toLowerCase();

  if (!scan || scan.page !== args.index) return [];

  return scan.text.toLowerCase().includes(term) ? [SIMULATED_SCAN_BOX] : [];
}

type RowMarks = Record<string, { parent: string; mark: number }>;

function rowMarks(): RowMarks {
  return JSON.parse(localStorage.getItem("kladde-test-row-marks") ?? "{}");
}

function lastMark() {
  return Math.max(0, ...Object.values(rowMarks()).map((m) => m.mark));
}

function markRows(rows: Stored[]) {
  const marks = rowMarks();
  let mark = lastMark();

  for (const row of rows)
    if (row.parent) marks[row.id] = { parent: row.parent, mark: ++mark };
  localStorage.setItem("kladde-test-row-marks", JSON.stringify(marks));
}

export async function mock<T>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  if (!import.meta.env.DEV) throw new Error("Disabled");
  const data: Record<string, Stored> = JSON.parse(
    localStorage.getItem("kladde-test-notes") ?? "{}",
  );
  const history: Versions = JSON.parse(localStorage.getItem(VERSIONS) ?? "{}");
  let result: unknown;

  switch (name) {
    case "account_info":
      result =
        simulatedSync() &&
        !simulatedBooks().excluded.includes(String(args.space))
          ? ["https://sync.example.org", "test", args.space ?? "", "device"]
          : null;
      break;
    case "sync_choices":
      if (!simulatedSync()) throw Error("Not connected");
      result = simulatedChoices(data);
      break;
    case "exclude_space":
      simulatedExclusion(String(args.space), args.excluded === true);
      break;
    case "remove_space":
      simulatedRemoval(String(args.space));
      break;
    case "delete_space":
      simulatedDeletion(data, String(args.space));
      break;
    case "remote_spaces":
      result = simulatedLink(args.link);
      break;
    case "sync_others":
      if (!simulatedSync()) throw Error("Not connected");
      result = [];
      break;
    case "sync_now": {
      const sync = simulatedSync();

      if (!sync) throw Error("Not connected");
      if (sync.error) throw Error(sync.error);
      result = {
        changed: [],
        removed: [],
        rescue: [],
        failed: [],
        retry: [],
        waiting: 0,
        stopped: null,
        ...sync.report,
      };
      break;
    }
    case "haptic":
      break;
    case "platform":
      result = new URLSearchParams(location.search).has("iphone")
        ? "ios"
        : "macos";
      break;
    case "spaces":
      result = Object.values(data)
        .filter((n) => n.kind === "workspace")
        .map((n) => [n.id, n.title]);
      break;
    case "opened_space":
      result = localStorage.getItem(OPENED_SPACE);
      break;
    case "remember_space":
      localStorage.setItem(OPENED_SPACE, String(args.id));
      break;
    case "load_manifest": {
      const n = data[String(args.id)];

      if (!n || n.kind !== "workspace") throw Error("Unknown notebook");
      const bytes = new Uint8Array(n.data.length + 8);

      new DataView(bytes.buffer).setBigInt64(0, BigInt(n.rev), true);
      bytes.set(n.data, 8);
      result = bytes.buffer;
      break;
    }
    case "load":
      result = data[String(args.id)] ?? null;
      break;
    case "load_state": {
      const n = data[String(args.id)];

      if (!n || n.space !== args.space || n.kind !== args.kind) {
        result = new ArrayBuffer(0);
        break;
      }

      const fresh = n.rev > Number(args.after);
      const bytes = new Uint8Array(8 + (fresh ? n.data.length : 0));

      new DataView(bytes.buffer).setBigInt64(0, BigInt(n.rev), true);
      if (fresh) bytes.set(n.data, 8);
      result = bytes.buffer;
      break;
    }
    case "save":
      for (const n of args.notes as Stored[]) {
        if ((data[n.id]?.rev ?? 0) !== n.rev)
          throw new Error("Notebook was modified");
        if (data[n.id]) capture(history, data[n.id], n);
        savedAt.set(n.id, seconds());
        data[n.id] = { ...n, rev: n.rev + 1 };
      }

      markRows(
        (args.notes as Stored[]).filter((n) => n.kind === "row" && n.parent),
      );
      localStorage.setItem("kladde-test-notes", JSON.stringify(data));
      localStorage.setItem(VERSIONS, JSON.stringify(history));
      break;
    case "search":
    case "search_content": {
      const query = String(args.query).toLowerCase();
      const listed = Object.values(data).filter(
        (n) => n.space === args.space && !n.archived,
      );
      const matches = listed.filter((n) =>
        (n.title + " " + simulatedReadable(n.body))
          .toLowerCase()
          .includes(query),
      );
      const pages = matches.map((n) => ({
        doc: n.id,
        file: null,
        name: "",
        snippet: simulatedReadable(n.body).slice(0, 360),
        offset: 0,
      }));

      result =
        name === "search"
          ? matches.map((n) => n.id)
          : { hits: [...pages, ...fileHits(listed, query)], pending: 0 };
      break;
    }
    case "open_web_source": {
      const url = new URL(String(args.address));
      const webPage =
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password;
      const mailAddress =
        url.protocol === "mailto:" && SINGLE_MAILBOX.test(url.pathname);

      if (webPage) window.open(url.href, "_blank", "noopener,noreferrer");
      else if (mailAddress)
        window.open("mailto:" + url.pathname, "_blank", "noopener,noreferrer");
      break;
    }
    case "add_file": {
      const id = crypto.randomUUID();
      const binary = atob(String(args.data));

      simulatedFiles.set(
        id,
        Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      );
      result = id;
      break;
    }
    case "read_file":
      result = simulatedFiles.get(String(args.id))?.buffer;
      break;
    case "preview_attachment":
    case "attachment_thumbnail":
      result = simulatedPreview(String(args.file), Number(args.index ?? 0));
      break;
    case "pdf_pages":
      result = simulatedPdfPages(String(args.file));
      break;
    case "find_in_attachment":
      result = simulatedFound(args);
      break;
    case "find_all_in_attachment":
      result = simulatedMatches(args);
      break;
    case "edit_pdf": {
      const bytes = simulatedFiles.get(String(args.file));

      if (!bytes || !isSimulatedPdf(bytes)) throw new Error("Invalid file");
      const id = crypto.randomUUID();
      const copy = bytes.slice();

      simulatedFiles.set(id, copy);
      simulatedPdfEdits.push(args.edit);
      result = {
        parts: [id],
        sha256: [await contentHash(new Blob([copy]))],
        size: bytes.length,
      };
      break;
    }
    case "save_download":
    case "export_file":
      result = String(args.name);
      break;
    case "list_attachments":
      result = [];
      break;
    case "rows": {
      const listed = Object.values(data).filter(
        (n) =>
          n.kind === "row" &&
          n.space === args.space &&
          n.parent === args.parent &&
          !n.archived,
      );
      const from = Number(args.after ?? 0);
      const page = listed.slice(from, from + ROW_PAGE);
      const next = from + ROW_PAGE < listed.length ? from + ROW_PAGE : null;

      result = [page.map((n) => [n.id, n.title, n.props]), next, lastMark()];
      break;
    }
    case "rows_changed": {
      const changed = Object.entries(rowMarks())
        .filter(
          ([, m]) => m.parent === args.parent && m.mark > Number(args.since),
        )
        .sort(([, a], [, b]) => a.mark - b.mark);
      const rows = changed.map(([id]) => {
        const n = data[id];

        return [id, n?.title ?? "", n?.props ?? "{}", !n || n.archived];
      });

      result = [rows, null, changed.at(-1)?.[1].mark ?? Number(args.since)];
      break;
    }
    case "backlinks":
      result = Object.values(data)
        .filter((n) => !n.archived && n.links.includes(String(args.id)))
        .map((n) => n.id);
      break;
    case "versions":
      result = listedVersions(history, String(args.id));
      break;
    case "version":
      result = storedVersion(history, args);
      break;
    case "keep_version":
      result = keepVersion(history, data[String(args.id)], args);
      localStorage.setItem(VERSIONS, JSON.stringify(history));
      break;
    case "label_version":
      labelVersion(history, args);
      localStorage.setItem(VERSIONS, JSON.stringify(history));
      break;
    case "delete_version":
      history[String(args.id)] = (history[String(args.id)] ?? []).filter(
        (version) => version.rev !== args.rev,
      );
      localStorage.setItem(VERSIONS, JSON.stringify(history));
      break;
    case "share_versions":
      result = shareVersions(history, data[String(args.doc)]);
      localStorage.setItem(VERSIONS, JSON.stringify(history));
      break;
    case "shared_version":
      result = sharedVersion(data[String(args.doc)], String(args.file));
      break;
    case "drop_shared_version":
      dropShared(history, data[String(args.doc)], String(args.file));
      localStorage.setItem(VERSIONS, JSON.stringify(history));
      break;
    case "forget":
    case "discard_rescued":
      markRows(Object.values(data).filter((n) => n.id === args.id));
      delete data[String(args.id)];
      delete history[String(args.id)];
      localStorage.setItem("kladde-test-notes", JSON.stringify(data));
      localStorage.setItem(VERSIONS, JSON.stringify(history));
      break;
    case "ai_policy":
      result = JSON.parse(
        localStorage.getItem("kladde-test-ai-" + args.space) ?? "null",
      ) ?? {
        enabled: false,
        zdr: true,
        web_search: false,
        model: "",
        budget: 0.5,
        steps: 25,
      };
      break;
    case "ai_settings":
      localStorage.setItem(
        "kladde-test-ai-" + args.space,
        JSON.stringify(args.settings),
      );
      break;
    case "ai_key":
      localStorage.setItem("kladde-test-ai-key", "true");
      break;
    case "ai_models":
      result = [{ id: "simuliert/kladde-dev" }];
      break;
    case "ai_start":
      runs++;
      result = "sim-run-" + runs;
      break;
    case "ai_stop":
      break;
    case "ai_turn":
      localStorage.setItem(
        "kladde-test-ai-request",
        JSON.stringify((args.turn as { messages: unknown[] }).messages),
      );
      result = await simulatedTurn(args);
      break;
    case "clip_page":
      result = simulatedClip(String(args.address));
      break;
    case "clipper_status":
    case "clipper_setup":
    case "clipper_remove":
      result = simulatedClipper(name);
      break;
    case "clipper_reveal":
      result = null;
      break;
    case "chrome":
      result = false;
      break;
    case "audio_languages":
      result = ["de-DE", "en-US", "fr-FR"];
      break;
    case "audio_start":
      startSimulatedRecording();
      break;
    case "audio_pause":
      pauseSimulatedRecording(true);
      break;
    case "audio_resume":
      pauseSimulatedRecording(false);
      break;
    case "audio_stop":
      result = stopSimulatedRecording(String(args.language));
      break;
    case "audio_discard":
      stopSimulatedRecording("");
      break;
    case "audio_save": {
      const id = crypto.randomUUID();

      simulatedFiles.set(id, SIMULATED_RECORDING);
      result = {
        parts: [id],
        sha256: [await contentHash(new Blob([SIMULATED_RECORDING]))],
        size: SIMULATED_RECORDING.length,
      };
      break;
    }
    case "audio_transcribe":
      result = {
        seconds: 0,
        text: SIMULATED_SPEECH.join(" "),
        transcribed: true,
        reason: "",
      };
      break;
    default:
      throw new Error("Requires native application");
  }

  return result as T;
}

const SIMULATED_SPEECH = [
  "Milch und Brot kaufen.",
  "Mara wegen Freitag anrufen.",
];
const SIMULATED_RECORDING = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
const SIMULATED_TICK_MS = 100;
const simulatedRecording = { timer: 0, ticks: 0, paused: false };

function announceAudio(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent("kladde-audio", { detail }));
}

function simulatedTick() {
  if (simulatedRecording.paused) return;
  simulatedRecording.ticks += 1;
  const seconds = (simulatedRecording.ticks * SIMULATED_TICK_MS) / 1000;

  announceAudio({ kind: "level", seconds, level: 0.3 + 0.4 * Math.random() });
  if (simulatedRecording.ticks === 3)
    announceAudio({
      kind: "text",
      settled: "",
      pending: SIMULATED_SPEECH[0],
    });
  if (simulatedRecording.ticks === 6)
    announceAudio({
      kind: "text",
      settled: SIMULATED_SPEECH[0],
      pending: "",
    });
}

function startSimulatedRecording() {
  if (simulatedRecording.timer) throw new Error("Audio is busy");
  simulatedRecording.ticks = 0;
  simulatedRecording.paused = false;
  simulatedRecording.timer = window.setInterval(
    simulatedTick,
    SIMULATED_TICK_MS,
  );
  queueMicrotask(() => announceAudio({ kind: "state", state: "recording" }));
}

function pauseSimulatedRecording(paused: boolean) {
  simulatedRecording.paused = paused;
  announceAudio({ kind: "state", state: paused ? "paused" : "recording" });
}

function stopSimulatedRecording(language: string) {
  window.clearInterval(simulatedRecording.timer);
  simulatedRecording.timer = 0;
  const seconds = (simulatedRecording.ticks * SIMULATED_TICK_MS) / 1000;
  const text = language.startsWith("en")
    ? "Buy milk and bread. Call Mara about Friday."
    : SIMULATED_SPEECH.join(" ");

  announceAudio({ kind: "done" });

  return { seconds, text, transcribed: true, reason: "" };
}

let clipperReady = false;

function simulatedClipper(name: string) {
  if (name !== "clipper_status") clipperReady = name === "clipper_setup";

  return {
    browsers: [
      { name: "Google Chrome", connected: clipperReady },
      { name: "Microsoft Edge", connected: clipperReady },
    ],
    folder:
      "/Users/simuliert/Library/Application Support/de.kladde.notebook/browser-extension",
    ready: clipperReady,
  };
}

let runs = 0;

const simulatedFiles = new Map<string, Uint8Array>();

const SIMULATED_PAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const IMAGE_SIGNATURES = ["\u0089PNG", "\u00ff\u00d8\u00ff", "GIF8", "RIFF"];

const SIMULATED_PDF_SIZES = [
  [595, 842],
  [595, 842],
  [842, 595],
];
const SIMULATED_PAGE_EDGE = 1200;

export const simulatedPdfEdits: unknown[] = [];

function isSimulatedPdf(bytes: Uint8Array) {
  return String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
}

function simulatedPdfPages(file: string) {
  const bytes = simulatedFiles.get(file);

  if (bytes && !isSimulatedPdf(bytes))
    throw new Error("PDF could not be opened");

  return { sizes: SIMULATED_PDF_SIZES, editable: true };
}

function simulatedPdfPage(index: number) {
  const [width, height] = SIMULATED_PDF_SIZES[index] ?? SIMULATED_PDF_SIZES[0];
  const scale = SIMULATED_PAGE_EDGE / Math.max(width, height);
  const canvas = document.createElement("canvas");

  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");

  if (!context) return SIMULATED_PAGE;
  context.scale(scale, scale);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#37352f";
  context.font = "600 28px Helvetica, Arial, sans-serif";
  context.fillText("Seite " + (index + 1), 56, 96);
  context.fillStyle = "#d3d1cb";
  for (let line = 0; line < 14; line++)
    context.fillRect(56, 140 + line * 28, width - 112 - (line % 3) * 60, 10);
  const url = canvas.toDataURL("image/jpeg", 0.85);

  return url.slice(url.indexOf(",") + 1);
}

function simulatedPreview(file: string, index: number) {
  const bytes = simulatedFiles.get(file);

  if (!bytes || isSimulatedPdf(bytes)) return [3, simulatedPdfPage(index)];
  const text = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

  if (IMAGE_SIGNATURES.some((signature) => text.startsWith(signature)))
    return [1, btoa(text)];

  return null;
}

function simulatedClip(address: string) {
  if (/localhost|127\.0\.0\.1/.test(address))
    throw new Error("Enter a public https web address");

  return {
    url: "https://example.org/artikel",
    title: "Simulierter Artikel",
    site: "Beispiel",
    byline: "Ada",
    published: "2026-11-02",
    markdown:
      "# Simulierter Artikel\n\nErster Absatz \\<b\\>sicher\\</b\\>\\.\n\n![Bild](clip-image:0)",
    images: ["https://example.org/bild.png"],
  };
}

interface SimulatedMessage {
  role: string;
  content?: string | null;
}
interface SimulatedChannel {
  onmessage: (part: unknown) => void;
}

function pause() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

interface ScriptedCall {
  name: string;
  arguments: unknown;
}

function nextToolCall() {
  const waiting: ScriptedCall[] = JSON.parse(
    localStorage.getItem(SCRIPTED_CALLS) ?? "[]",
  );
  const scripted = waiting.shift();

  if (!scripted) return { name: "workspace_tree", arguments: "{}" };
  localStorage.setItem(SCRIPTED_CALLS, JSON.stringify(waiting));

  return {
    name: scripted.name,
    arguments: JSON.stringify(scripted.arguments),
  };
}

function readJson(text: string | null | undefined) {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return null;
  }
}

async function simulatedTurn(args: Record<string, unknown>) {
  const turn = args.turn as { messages: SimulatedMessage[]; tools: unknown[] };
  const channel = args.channel as SimulatedChannel;
  const send = (delta: unknown) =>
    channel.onmessage({ choices: [{ delta }], usage: { total_tokens: 10 } });
  const toolMessages = turn.messages.filter((m) => m.role === "tool");

  if (turn.tools.length && !toolMessages.length) {
    await pause();
    send({
      tool_calls: [{ index: 0, id: "call-1", function: nextToolCall() }],
    });

    return 0.0001;
  }

  let answer: string;

  if (turn.tools.length) {
    const last = toolMessages[toolMessages.length - 1];
    const data = readJson(last.content)?.untrusted_notebook_data;
    const pages: { id: string; title: string }[] = Array.isArray(data)
      ? data
      : [];

    answer =
      "**Simulierte Antwort**\n\n" +
      pages
        .map((p) => "- [" + (p.title || "?") + "](kladde:" + p.id + ")")
        .join("\n");
  } else {
    const users = turn.messages.filter((m) => m.role === "user");
    const last = users[users.length - 1]?.content ?? "";
    const remembered = /<user>\n([^\n]*)/.exec(last);
    const request = readJson(last);

    answer = remembered
      ? "- " + remembered[1].slice(0, 200)
      : "Simulierter Text: " + String(request?.instruction ?? "");
  }

  for (const part of answer.match(/[\s\S]{1,12}/g) ?? []) {
    await pause();
    send({ content: part });
  }

  return 0.0001;
}
