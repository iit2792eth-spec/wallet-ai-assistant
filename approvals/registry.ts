import { randomUUID } from "node:crypto";
import { getSetting } from "@/db/settings";
import { publish } from "@/events/bus";
import type { ApprovalDecision, ApprovalInput, ApprovalOutcome, ApprovalRequest, PlanStep } from "./types";

type Pending = {
  request: ApprovalRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
};

// In memory only: a pending approval does not survive a server restart.
const globalForApprovals = globalThis as unknown as { __approvals?: Map<string, Pending> };
const pending = (globalForApprovals.__approvals ??= new Map());

const DEFAULT_TIMEOUT_SECONDS = 300;

function timeoutMs(): number {
  const seconds = Number(getSetting("approval_timeout_seconds"));
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS) * 1000;
}

function settle(id: string, decision: ApprovalDecision, selected?: number[]): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  clearTimeout(entry.timer);
  publish(entry.request.sessionId, { type: "approval_resolved", id, decision, ...(selected ? { selected } : {}) });
  entry.resolve(selected ? { decision, selected } : { decision });
  return true;
}

/**
 * Shows an approval card to the user and waits for the outcome.
 * Resolves with "expired" if the user does not decide in time.
 */
export async function requestApproval(input: ApprovalInput, options: { signal?: AbortSignal } = {}): Promise<ApprovalDecision> {
  return (await requestReview(input, options)).decision;
}

/**
 * Like requestApproval, but also returns which steps the user left ticked on a
 * plan card. `selected` is absent when the whole card was approved as shown.
 */
export function requestReview(input: ApprovalInput, options: { signal?: AbortSignal } = {}): Promise<ApprovalOutcome> {
  const id = randomUUID();
  const createdAt = Date.now();
  const ms = timeoutMs();
  const request = { ...input, id, createdAt, expiresAt: createdAt + ms } as ApprovalRequest;

  return new Promise((resolve) => {
    if (options.signal?.aborted) return resolve({ decision: "expired" });
    const timer = setTimeout(() => settle(id, "expired"), ms);
    pending.set(id, { request, resolve, timer });
    // A cancelled plan (session ended, time limit hit) expires its approval.
    options.signal?.addEventListener("abort", () => settle(id, "expired"), { once: true });
    publish(request.sessionId, { type: "approval_request", request });
  });
}

/** Expires every pending approval of a session, e.g. when the session ends. */
export function expireSession(sessionId: string): void {
  for (const [id, entry] of pending) {
    if (entry.request.sessionId === sessionId) settle(id, "expired");
  }
}

/** How long a user has to decide, in milliseconds. */
export function approvalTimeoutMs(): number {
  return timeoutMs();
}

/**
 * Records the user's decision. Returns false if the approval does not exist,
 * belongs to another session, was already settled, or `selected` names a step
 * that is not on the card (or is given for anything but approving a plan card).
 */
export function resolveApproval(
  id: string,
  sessionId: string,
  decision: "approved" | "rejected" | "keep",
  selected?: number[],
): boolean {
  const entry = pending.get(id);
  if (entry?.request.sessionId !== sessionId) return false;
  if (selected !== undefined) {
    const request = entry.request;
    if (decision !== "approved" || request.kind !== "plan" || !request.review) return false;
    const onCard = new Set(request.steps.map((step: PlanStep) => step.index));
    if (!selected.every((index) => onCard.has(index))) return false;
    return settle(id, decision, [...new Set(selected)].sort((a, b) => a - b));
  }
  return settle(id, decision);
}

export function listPending(sessionId: string): ApprovalRequest[] {
  return [...pending.values()]
    .map((entry) => entry.request)
    .filter((request) => request.sessionId === sessionId);
}
