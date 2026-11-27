"use client";

import { useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { Section } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CreateWalletDialog, ImportWalletDialog, RemoveWalletDialog, UnlockWalletDialog, lockWalletNow } from "@/components/wallet-dialogs";
import { useWalletStatus } from "@/hooks/use-wallet";

export function WalletSection() {
  const { status } = useWalletStatus();
  const [dialog, setDialog] = useState<"create" | "import" | "unlock" | "remove" | null>(null);
  const close = (open: boolean) => !open && setDialog(null);

  return (
    <Section title="Wallet">
      {!status ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !status.exists ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Not set up</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setDialog("create")}>
              Create
            </Button>
            <Button variant="outline" onClick={() => setDialog("import")}>
              Import
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <Badge variant={status.unlocked ? "default" : "secondary"}>
                {status.unlocked ? <LockOpen /> : <Lock />}
                {status.unlocked ? "Unlocked" : "Locked"}
              </Badge>
              <span className="truncate font-mono text-xs">{status.address}</span>
            </div>
            <div className="flex shrink-0 gap-2">
              {status.unlocked ? (
                <Button variant="outline" onClick={() => void lockWalletNow()}>
                  Lock
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setDialog("unlock")}>
                  Unlock
                </Button>
              )}
              <Button variant="destructive" onClick={() => setDialog("remove")}>
                Remove
              </Button>
            </div>
          </div>
        </div>
      )}

      <CreateWalletDialog open={dialog === "create"} onOpenChange={close} />
      <ImportWalletDialog open={dialog === "import"} onOpenChange={close} />
      <UnlockWalletDialog open={dialog === "unlock"} onOpenChange={close} />
      <RemoveWalletDialog open={dialog === "remove"} onOpenChange={close} />
    </Section>
  );
}
