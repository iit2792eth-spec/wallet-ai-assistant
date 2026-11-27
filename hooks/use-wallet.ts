"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { WALLET_CHANGED_EVENT, type WalletStatus } from "@/lib/wallet-types";

const POLL_MS = 30_000;

/** Tells every component showing wallet status to refresh. */
export function announceWalletChange(): void {
  window.dispatchEvent(new Event(WALLET_CHANGED_EVENT));
}

/**
 * The wallet's status. Refreshes after any wallet change in this tab, and every
 * 30 seconds so an automatic lock after idle time shows up.
 */
export function useWalletStatus(options: { onFirstLoad?: (status: WalletStatus) => void } = {}) {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const onFirstLoad = useRef(options.onFirstLoad);

  const reload = useCallback(async () => {
    try {
      setStatus(await api<WalletStatus>("GET", "/api/wallet"));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let first = true;
    const load = () =>
      api<WalletStatus>("GET", "/api/wallet").then(
        (next) => {
          if (cancelled) return;
          setStatus(next);
          if (first) onFirstLoad.current?.(next);
          first = false;
        },
        () => !cancelled && setStatus(null),
      );
    void load();
    const timer = setInterval(load, POLL_MS);
    window.addEventListener(WALLET_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(WALLET_CHANGED_EVENT, load);
    };
  }, []);

  return { status, reload };
}

/** True while a wallet exists and is locked: saved data (contacts, limits, models, settings) cannot be changed. */
export function useChangesLocked(): boolean {
  const { status } = useWalletStatus();
  return status?.exists === true && !status.unlocked;
}
