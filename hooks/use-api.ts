"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/client";

/** Loads JSON from a GET endpoint. Call reload() after a change. */
export function useApi<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<T>("GET", url).then(
      (result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      },
      (e) => {
        if (!cancelled) setError(errorMessage(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  const reload = useCallback(async () => {
    try {
      setData(await api<T>("GET", url));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [url]);

  return { data, error, reload };
}
