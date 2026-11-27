"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Lock, LockOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { UnlockWalletDialog, lockWalletNow } from "@/components/wallet-dialogs";
import { useWalletStatus } from "@/hooks/use-wallet";
import { shortAddress } from "@/lib/format";
import { WALLET_UNLOCK_REQUESTED_EVENT } from "@/lib/wallet-types";

/** Top bar wallet status. Click to unlock or lock; with no wallet, links to Settings. */
export function WalletBadge() {
  const [unlocking, setUnlocking] = useState(false);
  // When the app opens with a locked wallet, ask for the password straight away. Once per page load.
  const { status } = useWalletStatus({ onFirstLoad: (first) => first.exists && !first.unlocked && setUnlocking(true) });

  // While the wallet exists but is locked, the unlock dialog is mandatory: it
  // stays open and cannot be dismissed until the password is entered.
  const mustUnlock = Boolean(status?.exists && status.address && !status.unlocked);

  // A plan that needs to sign asks for the password through this event.
  useEffect(() => {
    const open = () => setUnlocking(true);
    window.addEventListener(WALLET_UNLOCK_REQUESTED_EVENT, open);
    return () => window.removeEventListener(WALLET_UNLOCK_REQUESTED_EVENT, open);
  }, []);

  // A pending unlock request only matters while the wallet is still locked; once
  // it reports unlocked, this term falls away and the dialog closes on its own.
  const showUnlock = mustUnlock || (unlocking && status?.unlocked !== true);

  if (!status) return null;
  if (!status.exists || !status.address) {
    return (
      <Badge variant="secondary" render={<Link href="/settings" />}>
        <Lock />
        No wallet
      </Badge>
    );
  }
  return (
    <>
      <Badge
        variant={status.unlocked ? "outline" : "secondary"}
        render={<button type="button" />}
        title={status.unlocked ? "Lock wallet" : "Unlock wallet"}
        onClick={() => (status.unlocked ? void lockWalletNow() : setUnlocking(true))}
      >
        {status.unlocked ? <LockOpen /> : <Lock />}
        <span className="font-mono">{shortAddress(status.address)}</span>
      </Badge>
      <UnlockWalletDialog open={showUnlock} required={mustUnlock} onOpenChange={setUnlocking} />
    </>
  );
}
