import { command } from "../platform/native";

export interface SearchHit {
  doc: string;
  file: string | null;
  name: string;
  snippet: string;
  offset: number;
  page?: number;
  matched?: string;
}

const MAX_TERMS = 16;

export function searchTerms(query: string) {
  return query
    .replaceAll('"', " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TERMS);
}

export function searchContent(space: string, query: string, parent?: string) {
  return command<{ hits: SearchHit[]; pending: number }>("search_content", {
    space,
    query,
    parent,
  });
}

export interface Passage {
  name: string;
  status: "ready" | "pending" | "partial" | "unsupported" | "unreadable";
  text: string;
  page?: number;
  next_offset: number | null;
}

export function readPassage(
  space: string,
  doc: string,
  file: string,
  offset: number,
  wait = false,
) {
  return command<Passage>("read_attachment", {
    space,
    doc,
    file,
    offset,
    wait,
  });
}

const sourceId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function notebookCitation(value: unknown): SearchHit | null {
  if (!value || typeof value !== "object") return null;
  const hit = value as SearchHit;

  if (
    typeof hit.doc !== "string" ||
    !sourceId.test(hit.doc) ||
    (hit.file !== null &&
      (typeof hit.file !== "string" || !sourceId.test(hit.file))) ||
    typeof hit.name !== "string" ||
    hit.name.length > 255 ||
    typeof hit.snippet !== "string" ||
    hit.snippet.length > 320 ||
    !Number.isSafeInteger(hit.page) ||
    hit.page! < 0 ||
    hit.page! >= 1048576 ||
    !Number.isSafeInteger(hit.offset) ||
    hit.offset < 0 ||
    hit.offset > 8388608
  )
    return null;

  return {
    doc: hit.doc,
    file: hit.file,
    name: hit.name,
    snippet: hit.snippet,
    matched: hit.snippet,
    page: hit.page,
    offset: hit.offset,
  };
}
