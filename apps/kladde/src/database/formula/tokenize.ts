import { FormulaError } from "./errors";

const MAX_TOKENS = 600;

export type Token =
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "name"; value: string }
  | { kind: "op"; value: string };

const OPERATORS = [
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "<>",
  "<",
  ">",
  "=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "!",
  "(",
  ")",
  ",",
  ".",
  "[",
  "]",
];
const WORD_OPERATORS: Record<string, string> = {
  and: "&&",
  or: "||",
  not: "!",
};
const NAME_START = /[\p{L}_]/u;
const NAME_PART = /[\p{L}\p{N}_]/u;

function readText(source: string, start: number) {
  const quote = source[start];
  let value = "";

  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];

    if (char === quote) return { value, end: i + 1 };

    if (char === "\\" && i + 1 < source.length) {
      const next = source[++i];

      value += next === "n" ? "\n" : next;
      continue;
    }

    value += char;
  }

  throw new FormulaError("syntax", quote);
}

function readNumber(source: string, start: number) {
  const match = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(start));

  if (!match) throw new FormulaError("syntax", source[start]);

  return { value: Number(match[0]), end: start + match[0].length };
}

function readName(source: string, start: number) {
  let end = start;

  while (end < source.length && NAME_PART.test(source[end])) end++;

  return { value: source.slice(start, end), end };
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    if (tokens.length > MAX_TOKENS) throw new FormulaError("tooComplex");
    const char = source[i];

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (char === '"' || char === "'") {
      const text = readText(source, i);

      tokens.push({ kind: "text", value: text.value });
      i = text.end;
      continue;
    }

    if (/\d/.test(char)) {
      const number = readNumber(source, i);

      tokens.push({ kind: "number", value: number.value });
      i = number.end;
      continue;
    }

    if (NAME_START.test(char)) {
      const name = readName(source, i);
      const word = WORD_OPERATORS[name.value.toLowerCase()];

      tokens.push(
        word
          ? { kind: "op", value: word }
          : { kind: "name", value: name.value },
      );
      i = name.end;
      continue;
    }

    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));

    if (!op) throw new FormulaError("syntax", char);
    tokens.push({ kind: "op", value: op });
    i += op.length;
  }

  return tokens;
}
