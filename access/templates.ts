import { formatUnits } from "viem";
import type { PlanApproval, PlanReview, PlanStep } from "@/approvals/types";
import type { Network } from "@/db/networks";
import type { StepLine } from "@/events/types";
import { shortAddress } from "@/lib/logger";
import type { Analysis, Step } from "./types";

// Text the user sees about a plan, built from real values by fixed templates.
// The model never writes any of it.

const eth = (wei: bigint) => `${formatUnits(wei, 18)} ETH`;

function recipient(step: Extract<Step, { kind: "transfer" }>): string {
  if (!step.to) return step.label ?? step.input;
  return step.label ? `${step.label} (${shortAddress(step.to)})` : shortAddress(step.to);
}

/** One sentence describing a step, e.g. "Send 0.5 ETH to Darshan (0x1234…5678) on Sepolia." */
export function describeStep(step: Step, network: Network): string {
  if (step.kind === "transfer") {
    return `Send ${formatUnits(step.amount, step.decimals)} ${step.token} to ${recipient(step)} on ${network.name}.`;
  }
  if (step.kind === "swap") {
    return step.side === "exact_in"
      ? `Swap ${formatUnits(step.amountIn, step.decimalsIn)} ${step.tokenIn} for at least ${formatUnits(step.minOut, step.decimalsOut)} ${step.tokenOut} on Uniswap (${network.name}).`
      : `Swap at most ${formatUnits(step.maxIn, step.decimalsIn)} ${step.tokenIn} for exactly ${formatUnits(step.amountOut, step.decimalsOut)} ${step.tokenOut} on Uniswap (${network.name}).`;
  }
  const what = step.knownType ?? step.primaryType;
  const app = typeof step.domain.name === "string" ? ` for ${step.domain.name}` : "";
  return `Sign a ${what} message${app}.${step.summary ? ` ${step.summary}` : ""}`;
}

function detail(step: Step, withFee: boolean): string | undefined {
  if (!step.runnable) return step.note;
  if (step.kind === "swap") {
    const parts = [
      step.side === "exact_in"
        ? `Quote: ${formatUnits(step.amountOut, step.decimalsOut)} ${step.tokenOut}`
        : `Quote: ${formatUnits(step.amountIn, step.decimalsIn)} ${step.tokenIn}`,
      `slippage ${(step.slippageBps / 100).toString()}%`,
      step.feeTier !== undefined ? `pool fee ${(step.feeTier / 10_000).toString()}%` : "",
      step.priceImpactBps !== undefined ? `price impact ${(step.priceImpactBps / 100).toFixed(2)}%` : "",
      withFee && step.feeWei !== undefined ? `fee up to ${eth(step.feeWei)}` : "",
    ];
    return parts.filter(Boolean).join(" · ");
  }
  if (withFee && step.kind === "transfer" && step.feeWei !== undefined) return `Estimated fee: up to ${eth(step.feeWei)}`;
  return step.note;
}

/** The card for explain and prepare modes. */
export function previewCard(analysis: Analysis, network: Network, mode: "explain" | "prepare"): { title: string; steps: StepLine[]; footer: string } {
  const steps = analysis.steps.map((step) => ({
    text: describeStep(step, network),
    state: step.runnable ? ("ready" as const) : ("blocked" as const),
    detail: detail(step, mode === "prepare"),
  }));
  const partial =
    analysis.runnableCount < analysis.steps.length
      ? ` Only ${analysis.runnableCount} of ${analysis.steps.length} steps could be completed.`
      : "";
  return mode === "explain"
    ? { title: "What this would do", steps, footer: `Nothing was prepared or signed.${partial}` }
    : {
        title: "Prepared, not signed",
        steps,
        footer: `Nothing was signed or sent.${analysis.totalFeeWei > BigInt(0) ? ` Total estimated fee: up to ${eth(analysis.totalFeeWei)}.` : ""}${partial}`,
      };
}

function toPlanStep(step: Step): PlanStep {
  if (step.kind === "transfer") {
    return {
      kind: "transfer",
      symbol: step.token,
      decimals: step.decimals,
      amount: step.amount.toString(),
      to: step.to ?? step.input,
      toLabel: step.label,
      provenance: step.provenance,
      feeWei: step.feeWei?.toString(),
      runnable: step.runnable,
      note: step.note,
      index: step.index,
      problem: step.problem,
    };
  }
  if (step.kind === "swap") {
    return {
      kind: "swap",
      symbolIn: step.tokenIn,
      symbolOut: step.tokenOut,
      decimalsIn: step.decimalsIn,
      decimalsOut: step.decimalsOut,
      side: step.side,
      amountIn: step.amountIn.toString(),
      amountOut: step.amountOut.toString(),
      maxIn: step.maxIn.toString(),
      minOut: step.minOut.toString(),
      feeTier: step.feeTier,
      priceImpactBps: step.priceImpactBps,
      slippageBps: step.slippageBps,
      slippageSource: step.slippageSource,
      settingsSlippageBps: step.settingsSlippageBps,
      feeWei: step.feeWei?.toString(),
      runnable: step.runnable,
      note: step.note,
      index: step.index,
      problem: step.problem,
    };
  }
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  return {
    kind: "typed_data",
    primaryType: step.primaryType,
    knownType: step.knownType,
    summary: step.summary,
    domain: plain(step.domain),
    message: plain(step.message),
    runnable: step.runnable,
    note: step.note,
    index: step.index,
    problem: step.problem,
  };
}

/** The approval card's content (everything except id and timestamps). */
export function approvalInput(
  sessionId: string,
  analysis: Analysis,
  network: Network,
  signer: string,
): Omit<PlanApproval, "id" | "createdAt" | "expiresAt"> {
  return {
    kind: "plan",
    sessionId,
    network: network.name,
    signer,
    warnings: analysis.warnings,
    steps: analysis.steps.map(toPlanStep),
    runnableCount: analysis.runnableCount,
    estimatedFeeWei: analysis.totalFeeWei > BigInt(0) ? analysis.totalFeeWei.toString() : undefined,
  };
}

/**
 * One batch of a plan for review: the card shows `steps` (a slice of the plan),
 * each with a checkbox, and the balances left after the batches already approved,
 * so the card can recheck feasibility as rows are unticked.
 */
export function reviewInput(
  sessionId: string,
  analysis: Analysis,
  steps: Step[],
  network: Network,
  signer: string,
  review: Omit<PlanReview, "balances"> & { balances: Record<string, bigint> },
): Omit<PlanApproval, "id" | "createdAt" | "expiresAt"> {
  const runnable = steps.filter((s) => s.runnable);
  const fee = runnable.reduce((sum, s) => sum + (s.kind === "transfer" || s.kind === "swap" ? s.feeWei ?? BigInt(0) : BigInt(0)), BigInt(0));
  const onCard = new Set(steps.map((s) => s.index));
  // Plan-wide warnings, then this card's typed-data warnings. Recipient and spender
  // warnings are summed up in one line: each row already marks where its address came from.
  const warnings = analysis.warnings.filter((w) => {
    if (w.code === "partial" || /^(?:recipient|spender)_/.test(w.code)) return false;
    // Set-aside document lines are listed on the first card only.
    if (w.code.startsWith("set_aside_")) return review.batch === 1;
    const typed = /^typed_(\d+)_/.exec(w.code);
    return !typed || onCard.has(Number(typed[1]));
  });
  const provenanceOf = (s: Step) => (s.kind === "transfer" ? s.to && s.provenance : s.kind === "sign_typed_data" ? s.spender?.provenance : undefined);
  const fromDocument = steps.filter((s) => provenanceOf(s) === "external").length;
  const untrusted = steps.filter((s) => provenanceOf(s) === "untrusted").length;
  const count = (n: number) => (n === 1 ? "1 address" : `${n} addresses`);
  if (runnable.length < steps.length) {
    const n = steps.length;
    warnings.unshift({
      code: "partial",
      message:
        runnable.length === 0
          ? review.batchCount > 1 ? "None of the steps on this card can be completed." : "None of the steps can be completed."
          : review.batchCount > 1 ? `Only ${runnable.length} of the ${n} steps on this card can be completed.` : `Only ${runnable.length} of ${n} steps can be completed.`,
    });
  }
  if (fromDocument) warnings.push({ code: "recipients_external", message: `${count(fromDocument)} on this card came from a web page, document or pasted text, not typed by you.` });
  if (untrusted) warnings.push({ code: "recipients_untrusted", message: `${count(untrusted)} on this card ${untrusted === 1 ? "was" : "were"} not typed by you and ${untrusted === 1 ? "is not a saved contact" : "are not saved contacts"}. Check each full address.` });
  return {
    kind: "plan",
    sessionId,
    network: network.name,
    signer,
    warnings,
    steps: steps.map(toPlanStep),
    runnableCount: runnable.length,
    estimatedFeeWei: fee > BigInt(0) ? fee.toString() : undefined,
    review: { ...review, balances: Object.fromEntries(Object.entries(review.balances).map(([k, v]) => [k, v.toString()])) },
  };
}
