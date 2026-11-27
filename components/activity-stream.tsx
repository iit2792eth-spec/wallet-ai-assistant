"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Clock, Loader2, Minus, X } from "lucide-react";
import type { ActivityEntry } from "@/events/types";
import { cn } from "@/lib/utils";

const ICONS = { running: Loader2, done: Check, failed: X, waiting: Clock, info: Minus } as const;
const COLORS = {
  running: "text-muted-foreground animate-spin",
  done: "text-success",
  failed: "text-destructive",
  waiting: "text-warning",
  info: "text-muted-foreground",
} as const;

function Line({ entry }: { entry: ActivityEntry }) {
  const Icon = ICONS[entry.state];
  return (
    <li className={cn("flex gap-2 py-0.5", entry.level === "detail" && "pl-6 text-xs")}>
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", COLORS[entry.state])} aria-label={entry.state} />
      <div className="min-w-0">
        {/* The program's own narration is shown in italics; everything else is reported by the app itself. */}
        <span className={cn(entry.source === "program" && "italic", entry.level === "detail" && "text-muted-foreground")}>{entry.text}</span>
        {entry.detail && <span className="ml-2 text-xs text-muted-foreground">{entry.detail}</span>}
      </div>
    </li>
  );
}

/** A request's live activity stream. Collapses to one line once the request has finished. */
export function ActivityStream({ entries, ended }: { entries: ActivityEntry[]; ended: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? !ended;
  const failed = entries.some((entry) => entry.state === "failed");
  const steps = entries.filter((entry) => entry.level !== "detail").length;

  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {ended ? `Activity · ${steps} step${steps === 1 ? "" : "s"}${failed ? " · with problems" : ""}` : "Working…"}
      </button>
      {expanded && <ol className="mt-1 border-l pl-3">{entries.map((entry) => <Line key={entry.id} entry={entry} />)}</ol>}
    </div>
  );
}
