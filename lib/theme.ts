// Theme config shared by the server (inline boot script) and the client (ThemeProvider).

export const COLOR_MODES = ["light", "dark", "system"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];
export type ResolvedMode = Exclude<ColorMode, "system">;

export const DEFAULT_MODE: ColorMode = "system";
export const THEME_STORAGE_KEY = "theme";

export function parseMode(raw: string | null): ColorMode {
  return COLOR_MODES.find((mode) => mode === raw) ?? DEFAULT_MODE;
}

/**
 * Applies the stored mode to <html>. It must stay self-contained (no imports or
 * outer references) because it is also serialised into the inline boot script.
 */
export function applyTheme(
  storageKey: string,
  modes: readonly string[],
  fallback: string,
): ResolvedMode {
  let mode = fallback;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored && modes.indexOf(stored) !== -1) mode = stored;
  } catch {}
  const resolved: ResolvedMode =
    mode === "light" || mode === "dark"
      ? mode
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  return resolved;
}

export const themeArgs = [
  THEME_STORAGE_KEY,
  COLOR_MODES,
  DEFAULT_MODE,
] as const;

/** Runs before first paint so the page never flashes the wrong theme. */
export const themeBootScript = `try{(${applyTheme.toString()}).apply(null,${JSON.stringify(themeArgs)})}catch(e){}`;
