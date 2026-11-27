"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  parseMode,
  themeArgs,
  type ColorMode,
  type ResolvedMode,
} from "@/lib/theme";

type ThemeContextValue = {
  mode: ColorMode;
  resolvedMode: ResolvedMode;
  setMode: (mode: ColorMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

// External store = the stored mode + the OS color-scheme preference.
const DARK_QUERY = "(prefers-color-scheme: dark)";
const LOCAL_CHANGE = "theme-change";

function subscribe(onChange: () => void) {
  const media = matchMedia(DARK_QUERY);
  const onStorage = (event: StorageEvent) =>
    event.key === THEME_STORAGE_KEY && onChange();
  media.addEventListener("change", onChange);
  window.addEventListener("storage", onStorage); // other tabs
  window.addEventListener(LOCAL_CHANGE, onChange); // this tab
  return () => {
    media.removeEventListener("change", onChange);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(LOCAL_CHANGE, onChange);
  };
}

function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

// Snapshots must be primitives, so encode as "<mode>|<systemDark>".
const getSnapshot = () =>
  `${parseMode(readStored())}|${matchMedia(DARK_QUERY).matches}`;
const getServerSnapshot = () => "";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const [storedMode, systemDark] = snapshot.split("|");
  const mode = parseMode(storedMode || null);
  const resolvedMode: ResolvedMode =
    mode === "system" ? (systemDark === "true" ? "dark" : "light") : mode;

  // The boot script themes <html> before paint; this keeps it in sync afterwards
  // (mode changes, OS changes, and React's dev-mode remount resetting <html>).
  useLayoutEffect(() => {
    if (snapshot) applyTheme(...themeArgs);
  }, [snapshot]);

  const setMode = useCallback((next: ColorMode) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {}
    window.dispatchEvent(new Event(LOCAL_CHANGE));
  }, []);

  const value = useMemo(
    () => ({ mode, resolvedMode, setMode }),
    [mode, resolvedMode, setMode],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
