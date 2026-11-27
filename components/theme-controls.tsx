"use client";

import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { COLOR_MODES, type ColorMode } from "@/lib/theme";

const MODE_META: Record<ColorMode, { label: string; icon: LucideIcon }> = {
  light: { label: "Light", icon: Sun },
  dark: { label: "Dark", icon: Moon },
  system: { label: "System", icon: Monitor },
};

/** Compact icon button for the top bar: cycles through COLOR_MODES. */
export function ThemeModeToggle() {
  const { mode, setMode } = useTheme();
  const next =
    COLOR_MODES[(COLOR_MODES.indexOf(mode) + 1) % COLOR_MODES.length];
  const { icon: Icon, label } = MODE_META[mode];
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Theme: ${label}. Switch to ${MODE_META[next].label}`}
      title={`Theme: ${label}`}
      onClick={() => setMode(next)}
    >
      <Icon />
    </Button>
  );
}

export function ModePicker() {
  const { mode, setMode } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Color mode"
      className="inline-flex gap-1 rounded-lg border p-1"
    >
      {COLOR_MODES.map((option) => {
        const { icon: Icon, label } = MODE_META[option];
        return (
          <Button
            key={option}
            role="radio"
            aria-checked={mode === option}
            size="sm"
            variant={mode === option ? "secondary" : "ghost"}
            onClick={() => setMode(option)}
          >
            <Icon />
            {label}
          </Button>
        );
      })}
    </div>
  );
}
