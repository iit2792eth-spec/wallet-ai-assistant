"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";
import { WALLET_CHANGED_EVENT, type TokenBalance } from "@/lib/wallet-types";

const REFRESH_MS = 60_000;

/** Short form for the top bar: up to 4 decimals, "<0.0001" for dust. The exact value is in the tooltip. */
function compact(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const short = fraction.slice(0, 4).replace(/0+$/, "");
  if (whole === "0" && short === "" && /[1-9]/.test(fraction)) return "<0.0001";
  return short ? `${whole}.${short}` : whole;
}

/**
 * The wallet's live balances, for the top bar. Reads from the chain on load,
 * after any wallet change, every minute while the tab is visible, and on refresh.
 */
export function BalanceBar({ address }: { address: string }) {
  const [balances, setBalances] = useState<TokenBalance[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBalances(await api<TokenBalance[]>("GET", "/api/wallet/balances"));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      api<TokenBalance[]>("GET", "/api/wallet/balances").then(
        (result) => {
          if (cancelled) return;
          setBalances(result);
          setFailed(false);
        },
        () => !cancelled && setFailed(true),
      );
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    window.addEventListener(WALLET_CHANGED_EVENT, refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(WALLET_CHANGED_EVENT, refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [address]);

  return (
    <div className="flex items-center gap-1 text-xs">
      {failed && <span className="text-muted-foreground">Balances unavailable</span>}
      {!failed && !balances && <span className="text-muted-foreground">Loading…</span>}
      {!failed &&
        balances?.map((balance) => (
          <span
            key={balance.token}
            className="rounded-md border px-2 py-0.5"
            title={balance.error ?? `${balance.formatted} ${balance.token}`}
          >
            <span className="font-mono">{balance.error === undefined ? compact(balance.formatted) : "—"}</span>{" "}
            <span className="text-muted-foreground">{balance.token}</span>
          </span>
        ))}
      <Button variant="ghost" size="icon-xs" aria-label="Refresh balances" disabled={loading} onClick={() => void load()}>
        <RefreshCw className={loading ? "animate-spin" : undefined} />
      </Button>
    </div>
  );
}
