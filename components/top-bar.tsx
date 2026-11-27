"use client";

import { usePathname } from "next/navigation";
import { BalanceBar } from "@/components/balance-bar";
import { ThemeModeToggle } from "@/components/theme-controls";
import { Badge } from "@/components/ui/badge";
import { WalletBadge } from "@/components/wallet-badge";
import { useApi } from "@/hooks/use-api";
import { useWalletStatus } from "@/hooks/use-wallet";
import type { AppSettings } from "@/lib/settings-types";

export function TopBar() {
  const { data: settings } = useApi<AppSettings>("/api/settings");
  const { status: wallet } = useWalletStatus();
  const onChat = usePathname() === "/";

  return (
    <header className="flex h-12 shrink-0 items-center justify-end gap-3 border-b px-4">
      {onChat && wallet?.address && (
        <div className="mr-auto">
          <BalanceBar address={wallet.address} />
        </div>
      )}
      {settings && <Badge variant="outline">{settings.network.name}</Badge>}
      <WalletBadge />
      <ThemeModeToggle />
    </header>
  );
}
