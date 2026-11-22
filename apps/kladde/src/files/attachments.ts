import { isTauri } from "@tauri-apps/api/core";
import { command, fileBase64 } from "../platform/native";
import { cleanName, download } from "./download";
import type { Notebook, Entry } from "../notebook/notebook";

export const FILE_PART_BYTES = 8 * 1024 * 1024;
const MAX_FILE_PARTS = 65536;
const FILE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface FileMeta {
  type: string;
  name: string;
  size: number;
  parts?: string[];
}

export function listedParts(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > MAX_FILE_PARTS)
    throw Error("Invalid file");
  const parts = value.map((part) => {
    if (typeof part !== "string" || !FILE_ID.test(part))
      throw Error("Invalid file");

    return part;
  });

  if (new Set(parts).size !== parts.length) throw Error("Invalid file");

  return parts;
}

export function fileMeta(entry: Entry, id: string): FileMeta | undefined {
  const stored: unknown = entry.doc.getMap("files").get(id);

  if (!stored || typeof stored !== "object") return undefined;
  const { type, name, size, parts } = stored as Record<string, unknown>;

  return {
    type: typeof type === "string" ? type : "",
    name: typeof name === "string" ? name : "",
    size: typeof size === "number" && size >= 0 ? size : 0,
    parts: listedParts(parts),
  };
}

const VIEWABLE =
  /^(image\/(png|jpeg|webp|gif|avif)|audio\/(mpeg|ogg|mp4|x-m4a|aac|wav|x-wav)|video\/mp4)$/;

const LOCAL_FILE = /^kladde-file:[0-9a-f-]{36}$/;

export const FILE_RETRY_MS = [2000, 5000, 10000, 20000, 40000, 60000];
const NOT_YET = /Download (failed|denied)/;

export function arrivesLater(problem: unknown, attempt: number) {
  return attempt < FILE_RETRY_MS.length && NOT_YET.test(String(problem));
}

async function awaitedPart(book: Notebook, doc: string, id: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await command<ArrayBuffer>("read_file", {
        space: book.id,
        doc,
        id,
        binary: true,
      });
    } catch (problem) {
      if (!arrivesLater(problem, attempt)) throw problem;
      await new Promise((done) => setTimeout(done, FILE_RETRY_MS[attempt]));
    }
  }
}

type FileBlock = "file" | "image" | "audio" | "video";

export function fileBlockType(file: File): FileBlock {
  if (!VIEWABLE.test(file.type)) return "file";

  return file.type.slice(0, file.type.indexOf("/")) as FileBlock;
}

export async function fileBlob(
  book: Notebook,
  entry: Entry,
  id: string,
  type = "application/octet-stream",
) {
  const parts = fileMeta(entry, id)?.parts ?? [id];
  const loaded: ArrayBuffer[] = [];

  for (const part of parts)
    loaded.push(await awaitedPart(book, entry.id, part));

  return new Blob(loaded, { type });
}

async function storeParts(book: Notebook, doc: string, file: Blob) {
  const parts: string[] = [];

  for (let offset = 0; offset === 0 || offset < file.size;) {
    const part = file.slice(offset, offset + FILE_PART_BYTES);
    const id = await command<string>("add_file", {
      space: book.id,
      doc,
      data: await fileBase64(part),
    });

    if (typeof id !== "string" || !FILE_ID.test(id))
      throw Error("Invalid file");
    parts.push(id);
    offset += FILE_PART_BYTES;
  }

  if (parts.length > MAX_FILE_PARTS) throw Error("Invalid file");

  return parts;
}

export function recordFile(
  entry: Entry,
  parts: string[],
  meta: Omit<FileMeta, "parts">,
) {
  const id = parts.length === 1 ? parts[0] : crypto.randomUUID();
  const listed = parts.length === 1 ? {} : { parts };

  entry.doc.getMap("files").set(id, { ...meta, ...listed });

  return id;
}

export async function saveFile(book: Notebook, entry: Entry, file: File) {
  await book.flush();
  const parts = await storeParts(book, entry.id, file);
  const id = recordFile(entry, parts, {
    type: file.type,
    name: file.name.slice(0, 255),
    size: file.size,
  });

  return "kladde-file:" + id;
}

export async function copyFile(
  source: Notebook,
  from: Entry,
  destination: Notebook,
  to: Entry,
  id: string,
) {
  const meta = fileMeta(from, id);

  if (!meta) return undefined;
  const parts: string[] = [];

  for (const part of meta.parts ?? [id]) {
    const bytes = await awaitedPart(source, from.id, part);
    const [copied] = await storeParts(destination, to.id, new Blob([bytes]));

    parts.push(copied);
  }

  const { type, name, size } = meta;

  return recordFile(to, parts, { type, name, size });
}

export async function localFile(book: Notebook, entry: Entry, url: string) {
  if (!LOCAL_FILE.test(url)) return "";
  const id = url.slice(12),
    meta = fileMeta(entry, id);

  if (!meta) return "";
  const type = VIEWABLE.test(meta.type)
    ? meta.type
    : "application/octet-stream";

  return URL.createObjectURL(await fileBlob(book, entry, id, type));
}

export function isPdf(entry: Entry, url: string, name: string) {
  if (/\.pdf$/i.test(name)) return true;

  return fileMeta(entry, url.slice(12))?.type === "application/pdf";
}

export async function exportFile(
  book: Notebook,
  entry: Entry,
  id: string,
  name: string,
) {
  const meta = fileMeta(entry, id);
  const label = name || meta?.name || "Kladde";

  if (!isTauri()) {
    const type = meta?.type || "application/octet-stream";

    await download(label, await fileBlob(book, entry, id, type), type);

    return;
  }

  await book.flush();
  await command("export_file", {
    space: book.id,
    doc: entry.id,
    id,
    name: cleanName(label),
  });
}

export async function downloadFile(
  book: Notebook,
  entry: Entry,
  url: string,
  name: string,
) {
  if (LOCAL_FILE.test(url)) {
    await exportFile(book, entry, url.slice(12), name);

    return;
  }

  if (/^https?:\/\//i.test(url))
    window.open(url, "_blank", "noopener,noreferrer");
}
