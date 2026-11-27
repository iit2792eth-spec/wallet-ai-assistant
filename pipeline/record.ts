import { formatUnits } from "viem";
import type { PlanReport, ReportStep } from "@/access";

// The conversation record of what the access layer did: written from fixed
// templates and real outcomes, never by a model. Addresses are replaced by the
// placeholders the model already knows; an address it was never given is not
// revealed. This is the only account of a request that later requests see.

const STATUS: Record<ReportStep["status"], string> = {
  confirmed: "confirmed",
  submitted: "sent, not yet confirmed",
  signed: "signed",
  failed: "failed",
  skipped: "not run",
  "not possible": "could not be done",
  rejected: "cancelled by the user",
  expired: "not approved in time",
  explained: "explained only, nothing sent",
  prepared: "prepared only, nothing sent",
};

type Masker = (value: string) => string | null;

function describe(step: ReportStep, mask: Masker): string {
  if (step.kind === "sign_typed_data") return `Sign a ${step.primaryType ?? "typed data"} message: ${STATUS[step.status]}.`;
  if (step.kind === "swap") {
    const paid = step.amount !== undefined && step.decimals !== undefined ? formatUnits(step.amount, step.decimals) : "?";
    const got = step.amountOut !== undefined && step.decimalsOut !== undefined ? formatUnits(step.amountOut, step.decimalsOut) : "?";
    return step.status === "confirmed"
      ? `Swap ${paid} ${step.token} to ${step.tokenOut}: confirmed, received ${got} ${step.tokenOut}.`
      : `Swap ${paid} ${step.token} to ${step.tokenOut}: ${STATUS[step.status]}.`;
  }
  const amount = step.amount !== undefined && step.decimals !== undefined ? formatUnits(step.amount, step.decimals) : "?";
  const to = step.to ? (mask(step.to) ?? (/^0x[0-9a-fA-F]{40}$/.test(step.to) ? "an address not given in this chat" : step.to)) : "an unknown recipient";
  return `Send ${amount} ${step.token} to ${to}: ${STATUS[step.status]}.`;
}

/** The record line for a finished plan. */
export function planRecord(report: PlanReport, mask: Masker): string {
  if (report.steps.length === 0) {
    return report.outcome === "completed" ? "(Done. Information was shown; nothing was sent or signed.)" : "(The request failed; nothing was sent or signed.)";
  }
  if (report.steps.length <= MAX_LISTED_STEPS) return `(${report.steps.map((step) => describe(step, mask)).join(" ")})`;
  // A long plan (a document table) is summed up, so later prompts stay short.
  const counts = new Map<string, number>();
  const totals = new Map<string, bigint>();
  const decimals = new Map<string, number>();
  for (const step of report.steps) {
    counts.set(STATUS[step.status], (counts.get(STATUS[step.status]) ?? 0) + 1);
    if (step.kind === "transfer" && step.token && step.amount !== undefined && (step.status === "confirmed" || step.status === "submitted")) {
      totals.set(step.token, (totals.get(step.token) ?? BigInt(0)) + step.amount);
      decimals.set(step.token, step.decimals ?? 18);
    }
  }
  const outcome = [...counts].map(([status, n]) => `${n} ${status}`).join(", ");
  const sent = [...totals].map(([token, sum]) => `${formatUnits(sum, decimals.get(token)!)} ${token}`).join(" and ");
  return `(${report.steps.length} steps: ${outcome}.${sent ? ` Sent in total: ${sent}.` : ""})`;
}

/** Plans with more steps than this are recorded as a summary instead of step by step. */
const MAX_LISTED_STEPS = 10;
