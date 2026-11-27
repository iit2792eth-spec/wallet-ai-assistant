"use client";

import { useMemo } from "react";
import { useSession } from "@/components/session-provider";

/** Approval requests waiting for the user, and the functions to answer them. */
export function useApprovals() {
  const { items, decide } = useSession();
  return useMemo(
    () => ({
      pending: items.flatMap((item) =>
        item.kind === "approval" && item.decision === null ? [item.request] : [],
      ),
      approve: (id: string) => decide(id, "approved"),
      /** Approves only the given steps of a plan card. */
      approveSelected: (id: string, selected: number[]) => decide(id, "approved", selected),
      reject: (id: string) => decide(id, "rejected"),
      keep: (id: string) => decide(id, "keep"),
    }),
    [items, decide],
  );
}
