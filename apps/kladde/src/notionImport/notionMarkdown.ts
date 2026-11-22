const LINK =
  /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(((?:[^()\s]|\([^()\s]*\))*(?:\([^()\s]*)?)\)/g;
const HEADING = /^#\s+\S/;
const FENCE = /^\s*(```|~~~)/;
const CALLOUT_START = /^\s*<aside>\s*$/;
const CALLOUT_END = /^\s*<\/aside>\s*$/;
const ICON =
  /^\p{Extended_Pictographic}(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\uFE0F)*$/u;

export interface MarkdownLink {
  whole: string;
  image: boolean;
  label: string;
  href: string;
}

export function markdownLinks(text: string): MarkdownLink[] {
  return Array.from(text.matchAll(LINK), (match) => ({
    whole: match[0],
    image: match[1] === "!",
    label: match[2],
    href: match[3],
  }));
}

export function rewriteLinks(
  text: string,
  replace: (link: MarkdownLink) => string,
) {
  return text.replace(
    LINK,
    (whole, bang: string, label: string, href: string) =>
      replace({ whole, image: bang === "!", label, href }),
  );
}

function propertyName(line: string, names: Set<string>) {
  const colon = line.indexOf(": ");
  const name = colon < 0 ? line.replace(/:$/, "") : line.slice(0, colon);

  return names.has(name) ? name : null;
}

export interface PageParts {
  properties: Map<string, string>;
  body: string;
}

export function splitPage(text: string, names: Set<string>): PageParts {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  let index = HEADING.test(lines[0] ?? "") ? 1 : 0;

  while (lines[index]?.trim() === "") index++;
  const properties = new Map<string, string>();

  if (!propertyName(lines[index] ?? "", names))
    return { properties, body: lines.slice(index).join("\n") };
  let current = "";

  for (; index < lines.length && lines[index].trim() !== ""; index++) {
    const line = lines[index];
    const name = propertyName(line, names);

    if (name) {
      current = name;
      properties.set(name, line.slice(name.length + 1).trim());
    } else if (current) {
      properties.set(current, properties.get(current) + "\n" + line);
    }
  }

  return {
    properties,
    body: lines.slice(index).join("\n").replace(/^\n+/, ""),
  };
}

function calloutLines(inner: string[]) {
  const lines = [...inner];

  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const icon = ICON.test(lines[0]?.trim() ?? "") ? lines.shift()!.trim() : "💡";

  while (lines.length && !lines[0].trim()) lines.shift();
  if (!lines.length) return ["> " + icon];
  lines[0] = icon + " " + lines[0].trim();

  return lines.map((line) => (line.trim() ? "> " + line : ">"));
}

export function convertCallouts(text: string) {
  const output: string[] = [];
  let fenced = false;
  let callout: string[] | null = null;

  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;

    if (!fenced && callout === null && CALLOUT_START.test(line)) {
      callout = [];
    } else if (!fenced && callout !== null && CALLOUT_END.test(line)) {
      output.push(...calloutLines(callout));
      callout = null;
    } else if (callout !== null) {
      callout.push(line);
    } else {
      output.push(line);
    }
  }

  if (callout !== null) output.push(...calloutLines(callout));

  return output.join("\n");
}

export function standaloneLines(text: string) {
  return new Set(text.split("\n").map((line) => line.trim()));
}
