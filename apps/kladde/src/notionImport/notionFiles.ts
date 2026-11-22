import { unzipSync } from "fflate";
import {
  exportName,
  fileName,
  normalizePath,
  stripCommonRoot,
  type Source,
} from "./notionPlan";

const MAX_FILES = 20_000;
const ASCII_END = 0x7f;
const LATIN1_END = 0xff;
const MAX_TEXT_BYTES = 8_000_000;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_NESTED_ZIPS = 2;
const EMPTY = new Uint8Array(0);
const IGNORED =
  /(^|\/)(\.DS_Store|DEVONtech_storage|__MACOSX(\/.*)?|index\.html|\._[^/]*)$/;
const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  heic: "image/heic",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  pdf: "application/pdf",
  txt: "text/plain",
  json: "application/json",
  html: "text/html",
};

export interface ExportFile {
  path: string;
  blob: Blob;
}

export function mimeType(path: string) {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();

  return MIME_TYPES[extension] ?? "application/octet-stream";
}

export function asFile(file: ExportFile) {
  return new File([file.blob], fileName(file.path), {
    type: mimeType(file.path),
  });
}

export function isZip(file: File) {
  return /\.zip$/i.test(file.name);
}

export function utf8Name(name: string) {
  const codes = Array.from(name, (char) => char.charCodeAt(0));

  if (!codes.some((c) => c > ASCII_END) || codes.some((c) => c > LATIN1_END))
    return name;

  try {
    const bytes = Uint8Array.from(codes);

    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return name;
  }
}

function unpack(bytes: Uint8Array, budget: { left: number }, depth: number) {
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      if (entry.name.endsWith("/")) return false;
      budget.left -= Math.max(entry.size, entry.originalSize);
      if (budget.left < 0) throw Error("Import limit");

      return true;
    },
  });

  return Object.entries(entries).map(([name, data]) => ({
    path: utf8Name(name),
    data,
    depth,
  }));
}

async function zipEntries(file: File) {
  const budget = { left: MAX_UNPACKED_BYTES };
  const result: ExportFile[] = [];
  const pending = unpack(new Uint8Array(await file.arrayBuffer()), budget, 0);

  for (let i = 0; i < pending.length; i++) {
    const { path, data, depth } = pending[i];

    if (/\.zip$/i.test(path) && depth < MAX_NESTED_ZIPS)
      pending.push(...unpack(data, budget, depth + 1));
    else
      result.push({ path, blob: new Blob([data as Uint8Array<ArrayBuffer>]) });
    pending[i].data = EMPTY;
    if (result.length > MAX_FILES) throw Error("Import limit");
  }

  return result;
}

function folderEntries(list: File[]) {
  return list.map((file) => ({
    path: file.webkitRelativePath || file.name,
    blob: file as Blob,
  }));
}

export async function exportFiles(list: File[]) {
  const zips = list.filter(isZip);
  const raw = [...folderEntries(list.filter((f) => !isZip(f)))];

  for (const zip of zips) raw.push(...(await zipEntries(zip)));
  const kept = raw.filter((f) => !IGNORED.test(f.path));

  if (kept.length > MAX_FILES) throw Error("Import limit");
  const paths = stripCommonRoot(kept.map((f) => normalizePath(f.path)));

  return kept.map((file, i) => ({ path: paths[i], blob: file.blob }));
}

export async function readSources(files: ExportFile[], skipped: string[]) {
  const sources: Source[] = [];

  for (const file of files) {
    if (!exportName(file.path)) continue;

    if (file.blob.size > MAX_TEXT_BYTES) {
      skipped.push(file.path);
      continue;
    }

    sources.push({ path: file.path, text: await file.blob.text() });
  }

  return sources;
}
