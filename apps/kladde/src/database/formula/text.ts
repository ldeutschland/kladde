import { limitList } from "./lists";
import { limitText, toNumber, toText, type Value } from "./values";

export function textContains(text: Value, part: Value) {
  const needle = toText(part).toLocaleLowerCase();

  if (Array.isArray(text))
    return text.some((item) => toText(item).toLocaleLowerCase() === needle);

  return toText(text).toLocaleLowerCase().includes(needle);
}

export function joined(first: Value, rest: Value[]) {
  if (Array.isArray(first))
    return limitText(first.map(toText).join(toText(rest[0] ?? ", ")));

  return limitText(rest.map(toText).join(toText(first)));
}

export function concatenated(args: Value[]) {
  if (args.some(Array.isArray))
    return limitList(args.flatMap((arg) => (Array.isArray(arg) ? arg : [arg])));

  return limitText(args.map(toText).join(""));
}

export function sliced(value: Value, start: Value, end: Value | undefined) {
  const from = toNumber(start);
  const to = end === undefined ? undefined : toNumber(end);

  if (Array.isArray(value)) return value.slice(from, to);

  return [...toText(value)].slice(from, to).join("");
}

export function splitText(text: string, separator: string) {
  const parts = separator ? text.split(separator) : [...text];

  return limitList(parts.map((part) => part.trim()).filter(Boolean));
}

export function position(text: string, part: string) {
  const at = text.indexOf(part);

  return at < 0 ? -1 : [...text.slice(0, at)].length;
}
