const THEME_KEY = "kladde-theme";
const THEMES: ReadonlySet<string> = new Set(["light", "dark", "system"]);

export function rememberTheme(theme: string) {
  if (!THEMES.has(theme)) return;

  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    return;
  }
}

export function restoreTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);

    if (stored && THEMES.has(stored))
      document.documentElement.dataset.theme = stored;
  } catch {
    return;
  }
}
