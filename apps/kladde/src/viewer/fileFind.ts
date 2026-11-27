import { foundBoxes, type FoundBox, type PageMarks } from "./foundMarks";

export interface FileMatch {
  page: number;
  boxes: FoundBox[];
}

const MAX_MATCHES = 1000;
const MAX_PAGE = 100_000;

function isPage(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) < MAX_PAGE
  );
}

function fileMatch(value: unknown): FileMatch[] {
  if (!value || typeof value !== "object") return [];
  const { page, boxes } = value as { page?: unknown; boxes?: unknown };

  return isPage(page) ? [{ page, boxes: foundBoxes(boxes) }] : [];
}

export function fileMatches(value: unknown): FileMatch[] {
  if (!Array.isArray(value)) return [];

  return value.slice(0, MAX_MATCHES).flatMap(fileMatch);
}

export function firstFrom(matches: FileMatch[], page: number) {
  return Math.max(
    matches.findIndex((match) => match.page >= page),
    0,
  );
}

export function pageMarks(matches: FileMatch[], current: number) {
  const marks = new Map<number, PageMarks>();

  matches.forEach((match, index) => {
    const page = marks.get(match.page) ?? { boxes: [], current: [] };

    if (index === current) page.current.push(...match.boxes);
    else page.boxes.push(...match.boxes);
    marks.set(match.page, page);
  });

  return marks;
}
