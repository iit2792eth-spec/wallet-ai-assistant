"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { ApprovalDecision, SlippageConfirmApproval } from "@/approvals/types";
import { Countdown } from "@/components/approval-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useApprovals } from "@/hooks/use-approvals";

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

const DECISIONS: Record<ApprovalDecision, string> = {
  approved: "Higher slippage confirmed",
  rejected: "Cancelled",
  expired: "Expired",
  keep: "Confirmed",
};

/** "Are you sure?" before a swap with a slippage the user typed above their setting. */
export function SlippageCard({ request, decision }: { request: SlippageConfirmApproval; decision: ApprovalDecision | null }) {
  const { approve, reject } = useApprovals();
  const [busy, setBusy] = useState(false);
  async function answer(act: (id: string) => Promise<void>) {
    setBusy(true);
    await act(request.id);
    setBusy(false);
  }

  return (
    <div className="rounded-lg border border-warning/40 bg-card text-sm">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 shrink-0 text-warning" />
          <span className="font-medium">Higher slippage than your setting</span>
        </div>
        {decision === null && <Countdown expiresAt={request.expiresAt} />}
      </div>
      <ul className="flex flex-col gap-2 px-4 py-3">
        {request.swaps.map((swap) => (
          <li key={swap.index} className="flex flex-col gap-0.5">
            <span>
              Step {swap.index + 1}, {swap.symbolIn} → {swap.symbolOut}: you asked for <span className="font-medium">{pct(swap.requestedBps)}</span> slippage; your setting is{" "}
              {pct(swap.settingsBps)}.
            </span>
            <span className="text-xs text-muted-foreground">{swap.effect}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-end gap-2 border-t px-4 py-2.5">
        {decision === null ? (
          <>
            <Button variant="outline" disabled={busy} onClick={() => void answer(reject)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void answer(approve)}>
              Yes, use {request.swaps.length === 1 ? pct(request.swaps[0].requestedBps) : "these"}
            </Button>
          </>
        ) : (
          <Badge variant={decision === "approved" ? "default" : "outline"}>{DECISIONS[decision]}</Badge>
        )}
      </div>
    </div>
  );
}
