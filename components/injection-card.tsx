"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, ShieldAlert } from "lucide-react";
import type { ApprovalDecision, InjectionReviewApproval } from "@/approvals/types";
import { Countdown } from "@/components/approval-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useApprovals } from "@/hooks/use-approvals";

const DECISIONS: Record<ApprovalDecision, string> = {
  approved: "Flagged content removed",
  keep: "Continued with flagged content",
  rejected: "Request cancelled",
  expired: "Expired",
};

const SOURCE = { web: "Web page", pdf: "PDF", pasted: "Pasted message" } as const;

/** Rounded down, so a score just under 100% never reads as 100%. */
const percent = (score: number) => `${(Math.floor(score * 1000) / 10).toFixed(1)}%`;

export function InjectionCard({ request, decision }: { request: InjectionReviewApproval; decision: ApprovalDecision | null }) {
  const { approve, reject, keep } = useApprovals();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const flagged = request.flagged ?? [];
  const hidden = request.flaggedCount - flagged.length;

  async function answer(act: (id: string) => Promise<void>) {
    setBusy(true);
    await act(request.id);
    setBusy(false);
  }

  return (
    <div className="rounded-lg border border-warning/40 bg-card text-sm">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <ShieldAlert className="size-4 shrink-0 text-warning" />
          <span className="font-medium">Possible injected instructions</span>
        </div>
        {decision === null && <Countdown expiresAt={request.expiresAt} />}
      </div>

      <div className="flex flex-col gap-1.5 px-4 py-3">
        <p>
          Something in{" "}
          <span className="font-medium">
            {SOURCE[request.source.kind].toLowerCase()}
            {request.source.ref && <span className="ml-1 break-all font-mono text-xs">{request.source.ref}</span>}
          </span>{" "}
          looks like it could be instructions aimed at the assistant, not ordinary content.
        </p>
        <p className="text-xs text-muted-foreground">
          {request.flaggedCount} of {request.sentenceCount} sentence{request.sentenceCount === 1 ? "" : "s"} were flagged. This
          can be a false alarm. You can remove the flagged parts, continue with everything, or cancel.
        </p>
        {flagged.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex w-fit items-center gap-1 text-xs font-medium text-foreground hover:underline"
          >
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {open ? "Hide flagged sentences" : "View flagged sentences"}
          </button>
        )}
        {open && (
          <div className="mt-1 flex flex-col gap-1.5">
            <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
              {flagged.map((f, i) => (
                <li key={i} className="flex items-start gap-3 rounded-md bg-muted/50 px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs">{f.text}</span>
                  <span className="shrink-0 font-mono text-xs text-warning tabular-nums">{percent(f.score)}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {hidden > 0 && `and ${hidden} more. `}Flagged at {percent(request.threshold)} or above.
            </p>
          </div>
        )}
      </div>

      {decision === null ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-2.5">
          <Button variant="outline" disabled={busy} onClick={() => void answer(reject)}>
            Cancel request
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void answer(keep)}>
            Continue anyway
          </Button>
          <Button disabled={busy} onClick={() => void answer(approve)}>
            Remove flagged and continue
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-end gap-2 border-t px-4 py-2.5">
          <Badge variant={decision === "approved" ? "default" : "outline"}>{DECISIONS[decision]}</Badge>
        </div>
      )}
    </div>
  );
}
