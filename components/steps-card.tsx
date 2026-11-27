import { Check, CircleDashed, Clock, ExternalLink, Minus, X } from "lucide-react";
import type { StepLine } from "@/events/types";
import { cn } from "@/lib/utils";

const ICONS = {
  ready: CircleDashed,
  done: Check,
  pending: Clock,
  failed: X,
  skipped: Minus,
  blocked: X,
} as const;

const COLORS = {
  ready: "text-muted-foreground",
  done: "text-success",
  pending: "text-muted-foreground",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
  blocked: "text-warning",
} as const;

/** A plan's steps: what it would do, what was prepared, or what happened. Plain text only. */
export function StepsCard({ title, steps, footer }: { title: string; steps: StepLine[]; footer?: string }) {
  return (
    <div className="rounded-lg border bg-card text-sm">
      <div className="border-b px-4 py-2.5 font-medium">{title}</div>
      <ol className="divide-y px-4">
        {steps.map((step, index) => {
          const Icon = ICONS[step.state];
          return (
            <li key={index} className="flex gap-3 py-2">
              <Icon className={cn("mt-0.5 size-4 shrink-0", COLORS[step.state])} aria-label={step.state} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="break-words">{step.text}</span>
                {step.detail && <span className="font-mono text-xs break-all text-muted-foreground">{step.detail}</span>}
              </div>
              {step.link && (
                <a
                  href={step.link}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View transaction"
                  className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="size-4" />
                </a>
              )}
            </li>
          );
        })}
      </ol>
      {footer && <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">{footer}</p>}
    </div>
  );
}
