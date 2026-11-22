import { FormulaError } from "./errors";
import { toText, type FormulaScope, type Value } from "./values";

const DAY_MS = 86400000;

export function parseDay(value: Value) {
  const text = toText(value).split("/")[0].trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
    throw new FormulaError("notDate", text);
  const time = Date.parse(text + "T00:00:00Z");

  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== text
  )
    throw new FormulaError("notDate", text);

  return new Date(time);
}

export function dayText(date: Date) {
  if (!Number.isFinite(date.getTime())) throw new FormulaError("notDate");

  return date.toISOString().slice(0, 10);
}

export function shiftDate(value: Value, amount: number, unit: string) {
  const date = parseDay(value);
  const whole = Math.trunc(amount);

  if (Math.abs(whole) > 100000) throw new FormulaError("arguments");
  if (unit === "years" || unit === "months") {
    const months = unit === "years" ? whole * 12 : whole;
    const day = date.getUTCDate();

    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const last = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
    ).getUTCDate();

    date.setUTCDate(Math.min(day, last));
  } else if (unit === "weeks") date.setUTCDate(date.getUTCDate() + whole * 7);
  else if (unit === "days") date.setUTCDate(date.getUTCDate() + whole);
  else throw new FormulaError("arguments", unit);

  return dayText(date);
}

export function between(first: Value, second: Value, unit: string) {
  const a = parseDay(first),
    b = parseDay(second);

  if (unit === "days") return Math.round((a.getTime() - b.getTime()) / DAY_MS);
  if (unit === "weeks")
    return Math.trunc((a.getTime() - b.getTime()) / (DAY_MS * 7));
  const months =
    (a.getUTCFullYear() - b.getUTCFullYear()) * 12 +
    a.getUTCMonth() -
    b.getUTCMonth() -
    (a.getUTCDate() < b.getUTCDate() && a > b ? 1 : 0) +
    (a.getUTCDate() > b.getUTCDate() && a < b ? 1 : 0);

  if (unit === "months") return months;
  if (unit === "years") return Math.trunc(months / 12);
  throw new FormulaError("arguments", unit);
}

export function isoWeek(value: Value) {
  const date = parseDay(value);
  const weekday = (date.getUTCDay() + 6) % 7;

  date.setUTCDate(date.getUTCDate() - weekday + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));

  return (
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / DAY_MS -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    )
  );
}

const DATE_TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd/g;
const PATTERN_LENGTH = 100;

function dateName(
  date: Date,
  lang: string | undefined,
  options: Intl.DateTimeFormatOptions,
) {
  return new Intl.DateTimeFormat(lang || undefined, {
    ...options,
    timeZone: "UTC",
  }).format(date);
}

function dateToken(token: string, date: Date, lang: string | undefined) {
  const pad = (n: number) => String(n).padStart(2, "0");

  switch (token) {
    case "YYYY":
      return String(date.getUTCFullYear());
    case "YY":
      return String(date.getUTCFullYear()).slice(-2);
    case "MMMM":
      return dateName(date, lang, { month: "long" });
    case "MMM":
      return dateName(date, lang, { month: "short" });
    case "MM":
      return pad(date.getUTCMonth() + 1);
    case "M":
      return String(date.getUTCMonth() + 1);
    case "DD":
      return pad(date.getUTCDate());
    case "D":
      return String(date.getUTCDate());
    case "dddd":
      return dateName(date, lang, { weekday: "long" });
    default:
      return dateName(date, lang, { weekday: "short" });
  }
}

export function formatDay(
  value: Value,
  pattern: string | undefined,
  scope: FormulaScope,
) {
  const date = parseDay(value);

  if (pattern === undefined)
    return dateName(date, scope.lang, { dateStyle: "long" });
  if (pattern.length > PATTERN_LENGTH) throw new FormulaError("tooComplex");

  return pattern.replace(DATE_TOKENS, (token, literal?: string) =>
    literal !== undefined ? literal : dateToken(token, date, scope.lang),
  );
}
