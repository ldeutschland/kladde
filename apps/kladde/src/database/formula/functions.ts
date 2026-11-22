import { FormulaError } from "./errors";
import {
  cleanNumber,
  compare,
  limitText,
  round,
  rowOf,
  same,
  toNumber,
  toText,
  truthy,
  type FormulaScope,
  type Value,
} from "./values";
import {
  LIST_LIMIT,
  flatten,
  isEmpty,
  listItems,
  median,
  numbers,
  unique,
} from "./lists";
import {
  concatenated,
  joined,
  position,
  sliced,
  splitText,
  textContains,
} from "./text";
import {
  between,
  dayText,
  formatDay,
  isoWeek,
  parseDay,
  shiftDate,
} from "./dates";

const MAX_REPEAT = 200;

export type Eager = (args: Value[], scope: FormulaScope) => Value;

export const eager: Record<string, [number, number, Eager]> = {
  title: [
    0,
    1,
    ([row], scope) => (row === undefined ? scope.title() : rowOf(row).title),
  ],
  not: [1, 1, ([x]) => !truthy(x)],
  empty: [1, 1, ([x]) => isEmpty(x)],
  length: [
    1,
    1,
    ([x]) => (Array.isArray(x) ? x.length : [...toText(x)].length),
  ],
  count: [1, 1, ([x]) => listItems(x).length],
  concat: [0, 50, (args) => concatenated(args)],
  join: [1, 50, ([first, ...rest]) => joined(first, rest)],
  list: [0, LIST_LIMIT, (args) => args],
  first: [1, 1, ([x]) => listItems(x)[0] ?? null],
  last: [1, 1, ([x]) => listItems(x).at(-1) ?? null],
  sort: [1, 1, ([x]) => [...listItems(x)].sort(compare)],
  reverse: [1, 1, ([x]) => [...listItems(x)].reverse()],
  unique: [1, 1, ([x]) => unique(listItems(x))],
  flat: [1, 1, ([x]) => flatten(listItems(x))],
  includes: [
    2,
    2,
    ([x, item]) => listItems(x).some((entry) => same(entry, item)),
  ],
  lower: [1, 1, ([x]) => toText(x).toLocaleLowerCase()],
  upper: [1, 1, ([x]) => toText(x).toLocaleUpperCase()],
  trim: [1, 1, ([x]) => toText(x).trim()],
  contains: [2, 2, ([x, part]) => textContains(x, part)],
  startswith: [2, 2, ([x, part]) => toText(x).startsWith(toText(part))],
  endswith: [2, 2, ([x, part]) => toText(x).endsWith(toText(part))],
  replace: [
    3,
    3,
    ([x, a, b]) => limitText(toText(x).replace(toText(a), toText(b))),
  ],
  replaceall: [
    3,
    3,
    ([x, a, b]) =>
      toText(a)
        ? limitText(toText(x).split(toText(a)).join(toText(b)))
        : toText(x),
  ],
  slice: [2, 3, ([x, start, end]) => sliced(x, start, end)],
  repeat: [
    2,
    2,
    ([x, n]) => {
      const times = Math.trunc(toNumber(n));

      if (times < 0 || times > MAX_REPEAT) throw new FormulaError("arguments");

      return limitText(toText(x).repeat(times));
    },
  ],
  format: [1, 1, ([x]) => toText(x)],
  tonumber: [1, 1, ([x]) => toNumber(x)],
  round: [1, 2, ([x, digits]) => round(x, digits ?? 0)],
  floor: [1, 1, ([x]) => Math.floor(toNumber(x))],
  ceil: [1, 1, ([x]) => Math.ceil(toNumber(x))],
  abs: [1, 1, ([x]) => Math.abs(toNumber(x))],
  sign: [1, 1, ([x]) => Math.sign(toNumber(x))],
  sqrt: [1, 1, ([x]) => cleanNumber(Math.sqrt(toNumber(x)))],
  pow: [2, 2, ([x, y]) => cleanNumber(toNumber(x) ** toNumber(y))],
  exp: [1, 1, ([x]) => cleanNumber(Math.exp(toNumber(x)))],
  ln: [1, 1, ([x]) => cleanNumber(Math.log(toNumber(x)))],
  log10: [1, 1, ([x]) => cleanNumber(Math.log10(toNumber(x)))],
  mod: [2, 2, ([x, y]) => cleanNumber(toNumber(x) % toNumber(y))],
  pi: [0, 0, () => Math.PI],
  min: [
    1,
    100,
    (args) => (numbers(args).length ? Math.min(...numbers(args)) : null),
  ],
  max: [
    1,
    100,
    (args) => (numbers(args).length ? Math.max(...numbers(args)) : null),
  ],
  sum: [1, 100, (args) => numbers(args).reduce((a, b) => a + b, 0)],
  average: [
    1,
    100,
    (args) => {
      const list = numbers(args);

      return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
    },
  ],
  median: [1, 100, (args) => median(numbers(args))],
  today: [0, 0, (_, scope) => scope.today],
  dateadd: [3, 3, ([d, n, unit]) => shiftDate(d, toNumber(n), toText(unit))],
  datesubtract: [
    3,
    3,
    ([d, n, unit]) => shiftDate(d, -toNumber(n), toText(unit)),
  ],
  datebetween: [3, 3, ([a, b, unit]) => between(a, b, toText(unit))],
  datestart: [1, 1, ([d]) => dayText(parseDay(toText(d).split("/")[0]))],
  dateend: [
    1,
    1,
    ([d]) => dayText(parseDay(toText(d).split("/").at(-1) ?? "")),
  ],
  year: [1, 1, ([d]) => parseDay(d).getUTCFullYear()],
  month: [1, 1, ([d]) => parseDay(d).getUTCMonth() + 1],
  day: [1, 1, ([d]) => parseDay(d).getUTCDate()],
  weekday: [1, 1, ([d]) => ((parseDay(d).getUTCDay() + 6) % 7) + 1],
  week: [1, 1, ([d]) => isoWeek(d)],
  formatdate: [
    1,
    2,
    ([d, pattern], scope) =>
      formatDay(d, pattern === undefined ? undefined : toText(pattern), scope),
  ],
  split: [2, 2, ([x, separator]) => splitText(toText(x), toText(separator))],
  at: [
    2,
    2,
    ([list, index]) => listItems(list).at(Math.trunc(toNumber(index))) ?? null,
  ],
  indexof: [2, 2, ([x, part]) => position(toText(x), toText(part))],
};

export const ITERATORS = [
  "map",
  "filter",
  "find",
  "findindex",
  "some",
  "every",
];
export const lazy = new Set([
  "if",
  "ifs",
  "and",
  "or",
  "prop",
  "let",
  "lets",
  "iferror",
  ...ITERATORS,
]);
export const knownFunctions = new Set([...Object.keys(eager), ...lazy]);

export const functionNames = [...knownFunctions].sort();
