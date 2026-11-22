import type { T } from "../locale/locale";

export function since(time: number, lang: string, t: T) {
  const minutes = Math.round((Date.now() - time) / 60000);

  if (minutes < 1) return t("justNow");
  const relative = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });

  if (minutes < 60) return relative.format(-minutes, "minute");
  if (minutes < 24 * 60)
    return relative.format(-Math.round(minutes / 60), "hour");

  return new Date(time).toLocaleDateString(lang, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
