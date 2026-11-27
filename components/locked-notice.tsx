"use client";

import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WALLET_UNLOCK_REQUESTED_EVENT } from "@/lib/wallet-types";

/** Shown on pages with editable data while the wallet is locked. */
export function LockedNotice({ locked }: { locked: boolean }) {
  if (!locked) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm text-muted-foreground">
      <span className="flex items-center gap-2">
        <Lock className="size-4" />
        Wallet locked. Unlock to make changes.
      </span>
      <Button variant="outline" size="sm" onClick={() => window.dispatchEvent(new Event(WALLET_UNLOCK_REQUESTED_EVENT))}>
        Unlock
      </Button>
    </div>
  );
}
