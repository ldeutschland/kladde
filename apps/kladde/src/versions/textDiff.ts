export type DiffKind = "same" | "added" | "removed";
export interface DiffPart {
  kind: DiffKind;
  text: string;
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const MAX_CELLS = 4_000_000;

function tokens(text: string) {
  return text.match(TOKEN) ?? [];
}

function sharedStart(a: string[], b: string[]) {
  let length = 0;

  while (length < a.length && length < b.length && a[length] === b[length])
    length++;

  return length;
}

function sharedEnd(a: string[], b: string[], start: number) {
  const limit = Math.min(a.length, b.length) - start;
  let length = 0;

  while (length < limit && a.at(-1 - length) === b.at(-1 - length)) length++;

  return length;
}

function add(parts: DiffPart[], kind: DiffKind, text: string) {
  if (!text) return;
  const last = parts.at(-1);

  if (last?.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

function commonLengths(a: string[], b: string[]) {
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);

  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);

  return table;
}

function changed(a: string[], b: string[]) {
  const parts: DiffPart[] = [];

  if (a.length * b.length > MAX_CELLS) {
    add(parts, "removed", a.join(""));
    add(parts, "added", b.join(""));

    return parts;
  }

  const table = commonLengths(a, b);
  const width = b.length + 1;
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const keepsBoth = a[i] === b[j];
    const dropsOld = table[(i + 1) * width + j] >= table[i * width + j + 1];

    if (keepsBoth) add(parts, "same", a[i]);
    else if (dropsOld) add(parts, "removed", a[i]);
    else add(parts, "added", b[j]);
    if (keepsBoth || dropsOld) i++;
    if (keepsBoth || !dropsOld) j++;
  }

  add(parts, "removed", a.slice(i).join(""));
  add(parts, "added", b.slice(j).join(""));

  return parts;
}

function joinRewrites(parts: DiffPart[]) {
  const joined: DiffPart[] = [];
  let removed = "";
  let added = "";
  const flush = () => {
    add(joined, "removed", removed);
    add(joined, "added", added);
    removed = added = "";
  };

  parts.forEach((part, index) => {
    const next = parts[index + 1];
    const bridges =
      part.kind === "same" &&
      !part.text.trim() &&
      !!removed &&
      !!added &&
      !!next &&
      next.kind !== "same";

    if (part.kind === "removed" || bridges) removed += part.text;
    if (part.kind === "added" || bridges) added += part.text;
    if (part.kind !== "same" || bridges) return;
    flush();
    add(joined, "same", part.text);
  });
  flush();

  return joined;
}

export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  const start = sharedStart(a, b);
  const end = sharedEnd(a, b, start);
  const parts: DiffPart[] = [];

  add(parts, "same", a.slice(0, start).join(""));
  const middle = changed(
    a.slice(start, a.length - end),
    b.slice(start, b.length - end),
  );

  for (const part of joinRewrites(middle)) add(parts, part.kind, part.text);
  add(parts, "same", a.slice(a.length - end).join(""));

  return parts;
}
