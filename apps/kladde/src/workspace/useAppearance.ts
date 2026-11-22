import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Notebook } from "../notebook/notebook";
import { translator } from "../locale/locale";
import { rememberTheme } from "../platform/startTheme";

function watchColorScheme(change: () => void) {
  const query = matchMedia("(prefers-color-scheme: dark)");

  query.addEventListener("change", change);

  return () => query.removeEventListener("change", change);
}

function systemIsDark() {
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

export function useAppearance(book: Notebook) {
  const systemDark = useSyncExternalStore(watchColorScheme, systemIsDark);
  const lang = String(book.settings.get("language") ?? "de"),
    theme = String(book.settings.get("theme") ?? "system"),
    dark = theme === "dark" || (theme === "system" && systemDark),
    t = useMemo(() => translator(lang), [lang]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dataset.theme = theme;
    rememberTheme(theme);
  }, [lang, theme]);

  return { lang, theme, dark, t };
}
