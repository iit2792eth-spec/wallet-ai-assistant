import type { Network } from "@/db/networks";
import { assessSteps, type CostStep } from "@/lib/feasibility";
import { shortAddress } from "@/lib/logger";
import type { Address } from "viem";
import { WalletError, buildSwapCall, estimateSwap, feeRates, getBalance, getPermitData, type Token } from "@/wallet";
import { LIMITS } from "./config";
import type { FeeBook } from "./fees";
import { percent, settingsSlippageBps, typedSlippages } from "./slippage";
import { AccessError, PlanBlocked, type Analysis, type ParsedAction, type PermitParams, type Step, type SwapAction, type SwapStep } from "./types";
import { resolveRecipient } from "./recipients";
import { buildPermit, loadTypedDataFile, checkTypedData } from "./typed-data";
import { spendLimit, spentSince, tokenRow } from "./record";

// Checks every action of a plan together, in order, before anything runs:
// security (blocks the whole plan), feasibility (finds the longest run of
// steps from the start that can be completed), and whether the plan may run
// without asking. Steps after the first one that cannot be completed are not
// run, because later steps may depend on earlier ones.

const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;

export type AnalysisContext = {
  sessionId: string;
  /** Fee estimates shared with the program and the transfer. */
  fees: FeeBook;
  network: Network;
  /** The user's wallet address, or null if none exists. */
  wallet: string | null;
  mode: "explain" | "prepare" | "sign";
  /** The request used someone else's text (a web page, PDF or pasted message): never auto-approved. */
  external: boolean;
  /** Which kind, for the warnings. */
  fromDocument?: boolean;
  pasted?: boolean;
  /** The user removed sentences the injection classifier flagged; shown first on the approval card. */
  injectionNotices?: string[];
  /** Document lines that may hold a payment but were set aside; shown on the first approval card. */
  setAsideNotices?: string[];
  /** The user's own typed messages for this request (never pasted text): the only place a swap slippage may come from. */
  userTyped?: string[];
};

const fmtUnits = (amount: bigint, decimals: number) => {
  const digits = amount.toString().padStart(decimals + 1, "0");
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${digits.slice(0, digits.length - decimals)}${fraction ? `.${fraction}` : ""}`;
};

/**
 * A Uniswap swap: quote every fee tier and take the best, then the least to
 * accept (exact input) or the most to pay (exact output) from the slippage.
 * The slippage is the Settings value unless the user typed another figure.
 */
async function buildSwapStep(ctx: AnalysisContext, action: SwapAction, index: number, batch: number, notes: string[]): Promise<SwapStep> {
  const rowIn = tokenRow(ctx.network.chainId, action.tokenIn);
  const rowOut = tokenRow(ctx.network.chainId, action.tokenOut);
  const settingsBps = settingsSlippageBps();
  let slippageBps = settingsBps;
  let slippageSource: SwapStep["slippageSource"] = "settings";
  if (action.slippageBps !== undefined) {
    if (typedSlippages(ctx.userTyped ?? []).includes(action.slippageBps)) {
      slippageBps = action.slippageBps;
      slippageSource = "user";
    } else {
      notes.push(`Step ${index + 1}: the program asked for ${percent(action.slippageBps)} slippage, which you did not type in this request, so your setting of ${percent(settingsBps)} is used.`);
    }
  }
  const step: SwapStep = {
    kind: "swap", index, batch, runnable: true,
    tokenIn: action.tokenIn, tokenOut: action.tokenOut, tokenInId: rowIn?.id ?? null, tokenOutId: rowOut?.id ?? null,
    decimalsIn: rowIn?.decimals ?? (action.tokenIn === "ETH" ? 18 : 6), decimalsOut: rowOut?.decimals ?? (action.tokenOut === "ETH" ? 18 : 6),
    side: action.side,
    amountIn: action.side === "exact_in" ? action.amount : BigInt(0),
    amountOut: action.side === "exact_out" ? action.amount : BigInt(0),
    maxIn: action.side === "exact_in" ? action.amount : BigInt(0),
    minOut: action.side === "exact_out" ? action.amount : BigInt(0),
    slippageBps, slippageSource, settingsSlippageBps: settingsBps,
    deadline: Math.floor(Date.now() / 1000) + LIMITS.swapDeadlineSeconds,
  };
  if (!rowIn) return { ...step, problem: `${action.tokenIn} is not available on ${ctx.network.name}.` };
  if (!rowOut) return { ...step, problem: `${action.tokenOut} is not available on ${ctx.network.name}.` };

  let quote;
  try {
    quote = await ctx.fees.quote(action.tokenIn, action.tokenOut, action.side, action.amount);
  } catch (error) {
    if (error instanceof WalletError && (error.code === "NO_SWAP_ROUTE" || error.code === "DEX_NOT_CONFIGURED" || error.code === "TOKEN_NOT_CONFIGURED")) {
      return { ...step, problem: error.message };
    }
    throw error;
  }
  const BPS = BigInt(10_000);
  const slip = BigInt(slippageBps);
  Object.assign(step, {
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    feeTier: quote.fee,
    pool: quote.pool,
    priceImpactBps: quote.priceImpactBps,
    minOut: action.side === "exact_in" ? (quote.amountOut * (BPS - slip)) / BPS : quote.amountOut,
    // Rounded up, so the most paid always covers the quote plus the slippage.
    maxIn: action.side === "exact_out" ? (quote.amountIn * (BPS + slip) + BPS - BigInt(1)) / BPS : quote.amountIn,
  });
  if (quote.priceImpactBps > LIMITS.swapImpactBlockBps) {
    return {
      ...step,
      problem: `The price impact would be ${percent(quote.priceImpactBps)}, above the ${percent(LIMITS.swapImpactBlockBps)} limit: the pool is too small for this amount.`,
    };
  }
  return step;
}


async function buildStep(ctx: AnalysisContext, action: ParsedAction, index: number, batch: number, notes: string[]): Promise<Step> {
  if (action.kind === "swap") return buildSwapStep(ctx, action, index, batch, notes);
  if (action.kind === "transfer") {
    const token = tokenRow(ctx.network.chainId, action.token);
    const recipient = await resolveRecipient(ctx.sessionId, action.to, ctx.external);
    const step: Step = {
      kind: "transfer",
      index,
      batch,
      runnable: true,
      token: action.token,
      tokenId: token?.id ?? null,
      decimals: token?.decimals ?? (action.token === "ETH" ? 18 : 6),
      amount: action.amount,
      input: action.to,
      to: recipient.to,
      label: recipient.label,
      provenance: recipient.provenance,
    };
    if (!token) return { ...step, problem: `${action.token} is not available on ${ctx.network.name}.` };
    if (recipient.problem) return { ...step, problem: recipient.problem };
    return step;
  }

  const empty: Extract<Step, { kind: "sign_typed_data" }> = {
    kind: "sign_typed_data", index, batch, runnable: true, typedData: null, primaryType: "unknown", domain: {}, message: {}, warnings: [],
  };
  try {
    if (action.permit) return await buildPermitStep(ctx, action.permit, empty);
    const raw = action.file !== undefined ? await loadTypedDataFile(action.file) : action.typedData;
    const checked = checkTypedData(raw, ctx.network.chainId, ctx.wallet);
    return { ...empty, ...checked, runnable: true };
  } catch (error) {
    if (error instanceof AccessError) return { ...empty, problem: error.message };
    throw error; // PlanBlocked
  }
}

const HOUR = 60 * 60;
const YEAR = 365 * DAY;

/** A permit described in words: resolve the spender, read the token's permit data, build and check the typed data. */
async function buildPermitStep(ctx: AnalysisContext, permit: PermitParams, empty: Extract<Step, { kind: "sign_typed_data" }>): Promise<Step> {
  const recipient = await resolveRecipient(ctx.sessionId, permit.spender, ctx.external);
  const spender = { label: recipient.label, provenance: recipient.provenance };
  const named = { ...empty, primaryType: "Permit", spender };
  if (!recipient.to) return { ...named, problem: recipient.problem };
  if (!ctx.wallet) return { ...named, problem: "No wallet is set up yet." };

  const now = Math.floor(Date.now() / 1000);
  const deadline = permit.deadline ?? now + HOUR;
  if (deadline <= now) return { ...named, problem: "The permit's deadline has already passed." };

  let data;
  try {
    data = await getPermitData({ token: permit.token });
  } catch (error) {
    if (error instanceof WalletError && error.code !== "RPC_UNAVAILABLE" && error.code !== "RPC_ERROR") {
      return { ...named, problem: error.message };
    }
    throw error;
  }
  const checked = checkTypedData(buildPermit(data, recipient.to, permit.amount, BigInt(deadline)), ctx.network.chainId, ctx.wallet);
  if (deadline > now + YEAR) checked.warnings.push("The permit lasts more than a year.");
  const label = recipient.label ? `${recipient.label} (${shortAddress(recipient.to)})` : shortAddress(recipient.to);
  return { ...named, ...checked, summary: checked.summary?.replace(shortAddress(recipient.to), label), runnable: true };
}

/** Fee estimates run this many at a time: a plan can have hundreds of recipients. */
const FEE_CONCURRENCY = 6;

async function inParallel<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The cost of each step, for the shared feasibility rules (lib/feasibility.ts). */
export function costSteps(steps: Step[]): CostStep[] {
  return steps.map((step) =>
    step.kind === "transfer"
      ? { index: step.index, kind: "transfer", token: step.token, decimals: step.decimals, amount: step.amount, feeWei: step.feeWei, problem: step.problem }
      : step.kind === "swap"
        ? { index: step.index, kind: "swap", token: step.tokenIn, decimals: step.decimalsIn, amount: step.maxIn, feeWei: step.feeWei, problem: step.problem, tokenOut: step.tokenOut, minOut: step.minOut }
        : { index: step.index, kind: "sign_typed_data", problem: step.problem },
  );
}

/**
 * Marks each step runnable or not, leaving out `excluded`, and returns how many
 * steps from the start can be completed. Used again whenever the user leaves steps out.
 */
export function applyFeasibility(steps: Step[], balances: Record<string, bigint>, excluded: ReadonlySet<number> = new Set()): { runnableCount: number } {
  const { verdicts, firstFailure } = assessSteps(costSteps(steps), excluded, balances);
  for (const [i, verdict] of verdicts.entries()) {
    steps[i].runnable = verdict.state === "runnable";
    steps[i].note = verdict.state === "blocked" ? verdict.note : undefined;
  }
  return { runnableCount: firstFailure === null ? steps.length : steps.findIndex((s) => s.index === firstFailure) };
}

/** Throws PlanBlocked for security problems; other problems mark steps as not runnable. */
export async function analyzePlan(ctx: AnalysisContext, actions: { action: ParsedAction; batch: number }[]): Promise<Analysis> {
  const steps: Step[] = [];
  const notes: string[] = [];
  for (const [index, { action, batch }] of actions.entries()) steps.push(await buildStep(ctx, action, index, batch, notes));
  // Steps after the first swap may spend what it buys, which the chain does not hold yet.
  const firstSwap = steps.find((s) => s.kind === "swap")?.index ?? Infinity;

  if (ctx.mode === "sign" && !ctx.wallet) throw new PlanBlocked("No wallet is set up yet. Create or import one in Settings.");

  // Fees, estimated in parallel. Explain mode reads balances but estimates no fees.
  if (ctx.mode !== "explain" && ctx.wallet) {
    const transfers = steps.filter((s): s is Extract<Step, { kind: "transfer" }> => s.kind === "transfer" && !s.problem && s.to !== null);
    await inParallel(transfers, FEE_CONCURRENCY, async (step) => {
      try {
        step.feeWei = (await ctx.fees.get(step.token, step.to!, step.amount)).maxFeeWei;
      } catch (error) {
        if (error instanceof WalletError && (error.code === "INSUFFICIENT_FUNDS" || error.code === "TRANSFER_REVERTED")) {
          // After a swap, the node cannot know about tokens the swap will bring: use a default gas
          // limit now (the feasibility check counts only the swap's minimum) and estimate again when sending.
          if (step.index > firstSwap) {
            const rates = await feeRates();
            step.feeWei = BigInt(LIMITS.transferFallbackGas) * rates.maxFeePerGas;
            return;
          }
          step.problem = error.message;
          return;
        }
        throw error;
      }
    });
    // Swaps: estimated from the real router call when possible (ETH in, nothing bought before);
    // a token-in swap needs a permit signed only after approval, so it gets the default gas limit.
    for (const step of steps) {
      if (step.kind !== "swap" || step.problem) continue;
      const rates = await feeRates();
      const fallback = { gas: BigInt(LIMITS.swapFallbackGas), maxFeePerGas: rates.maxFeePerGas, maxPriorityFeePerGas: rates.maxPriorityFeePerGas };
      if (step.tokenIn === "ETH" && step.index <= firstSwap) {
        try {
          const call = buildSwapCall({
            network: ctx.network,
            quote: { ...step, fee: step.feeTier! },
            limit: step.side === "exact_in" ? step.minOut : step.maxIn,
            owner: ctx.wallet as Address,
            deadline: BigInt(step.deadline),
          });
          const estimate = await estimateSwap(call);
          step.gas = { gas: estimate.gas, maxFeePerGas: estimate.maxFeePerGas, maxPriorityFeePerGas: estimate.maxPriorityFeePerGas };
        } catch (error) {
          if (!(error instanceof WalletError)) throw error;
          if (error.code === "INSUFFICIENT_FUNDS") {
            step.problem = `Not enough ETH for this swap: it needs ${fmtUnits(step.maxIn, 18)} ETH plus the network fee.`;
            continue;
          }
          if (error.code === "TRANSFER_REVERTED") {
            step.problem = "The swap would fail on chain at the current price. Try a smaller amount or a higher slippage.";
            continue;
          }
          throw error;
        }
      } else {
        step.gas = fallback;
      }
      step.feeWei = step.gas.gas * step.gas.maxFeePerGas;
    }
  }

  // Starting balances of every token involved (ETH too, for fees).
  const balances: Record<string, bigint> = {};
  if (ctx.wallet) {
    const tokens = new Set<Token>();
    for (const step of steps) {
      if (step.kind === "transfer" && step.tokenId !== null) {
        tokens.add(step.token);
        tokens.add("ETH");
      }
      if (step.kind === "swap" && step.tokenInId !== null && step.tokenOutId !== null) {
        tokens.add(step.tokenIn);
        tokens.add(step.tokenOut);
        tokens.add("ETH");
      }
    }
    for (const token of tokens) balances[token] = (await getBalance({ token })).amount;
  }

  const { runnableCount } = applyFeasibility(steps, balances);
  const runnable = steps.slice(0, runnableCount);

  const warnings: Analysis["warnings"] = [];
  for (const step of steps) {
    if (step.kind === "transfer" && step.to && (step.provenance === "external" || step.provenance === "untrusted")) {
      warnings.push({
        code: `recipient_${step.index}`,
        message:
          step.provenance === "external"
            ? `Step ${step.index + 1}: the recipient came from a web page, document or pasted text, not typed by you.`
            : `Step ${step.index + 1}: the recipient was not typed by you and is not a saved contact. Check the full address.`,
      });
    }
    if (step.kind === "sign_typed_data" && step.spender && (step.spender.provenance === "external" || step.spender.provenance === "untrusted")) {
      warnings.push({
        code: `spender_${step.index}`,
        message:
          step.spender.provenance === "external"
            ? `Step ${step.index + 1}: the spender came from a web page, document or pasted text, not typed by you.`
            : `Step ${step.index + 1}: the spender was not typed by you and is not a saved contact. Check the full address.`,
      });
    }
    if (step.kind === "sign_typed_data") {
      for (const message of step.warnings) warnings.push({ code: `typed_${step.index}_${warnings.length}`, message: `Step ${step.index + 1}: ${message}` });
    }
  }
  if (ctx.pasted) {
    warnings.unshift({ code: "pasted", message: "This request includes pasted text, which may contain someone else's instructions. Check every recipient and amount before approving." });
  }
  if (ctx.fromDocument || (ctx.external && !ctx.pasted)) {
    warnings.unshift({ code: "external", message: "This request uses data from a web page or document. Check every value before approving." });
  }
  // Set-aside lines go after the plan-wide notices, in order, so they read as one block.
  for (const step of steps) {
    if (step.kind !== "swap" || step.problem || step.priceImpactBps === undefined) continue;
    if (step.priceImpactBps > LIMITS.swapImpactWarnBps) {
      warnings.push({ code: `swap_impact_${step.index}`, message: `Step ${step.index + 1}: this swap moves the pool's price ${percent(step.priceImpactBps)} against you (beyond the pool fee).` });
    }
    if (step.slippageSource === "user" && step.slippageBps > step.settingsSlippageBps) {
      warnings.push({ code: `swap_slippage_${step.index}`, message: `Step ${step.index + 1}: you asked for ${percent(step.slippageBps)} slippage, above your setting of ${percent(step.settingsSlippageBps)}.` });
    }
  }
  for (const [i, message] of notes.entries()) warnings.push({ code: `note_${i}`, message });
  warnings.push(...(ctx.setAsideNotices ?? []).map((message, i) => ({ code: `set_aside_${i}`, message })));
  for (const [i, message] of (ctx.injectionNotices ?? []).entries()) warnings.unshift({ code: `injection_removed_${i}`, message });
  if (runnableCount < steps.length) {
    warnings.unshift({
      code: "partial",
      message: runnableCount === 0 ? "None of the steps can be completed." : `Only ${runnableCount} of ${steps.length} steps can be completed.`,
    });
  }

  return {
    steps,
    runnableCount,
    warnings,
    // Data from a web page or PDF always needs the user's approval, whatever the limits say.
    autoApprove: ctx.mode === "sign" && !ctx.external && runnableCount === steps.length && withinSavedLimits(steps),
    totalFeeWei: runnable.reduce((sum, step) => sum + (step.kind === "transfer" || step.kind === "swap" ? step.feeWei ?? BigInt(0) : BigInt(0)), BigInt(0)),
    balances,
  };
}

/**
 * Whether the plan may run without asking: only transfers, every recipient
 * typed by the user or a saved contact, and every token within its enabled
 * per-transaction, rolling 24-hour and rolling 7-day limits (batch totals included).
 */
function withinSavedLimits(steps: Step[]): boolean {
  if (steps.length === 0) return false;
  const totals = new Map<number, bigint>();
  for (const step of steps) {
    if (step.kind !== "transfer" || step.tokenId === null) return false;
    if (step.provenance !== "user" && step.provenance !== "contact") return false;
    const limit = spendLimit(step.tokenId);
    if (!limit || step.amount > limit.perTxMax) return false;
    totals.set(step.tokenId, (totals.get(step.tokenId) ?? BigInt(0)) + step.amount);
  }
  for (const [tokenId, total] of totals) {
    const limit = spendLimit(tokenId)!;
    if (spentSince(tokenId, DAY) + total > limit.dailyMax) return false;
    if (spentSince(tokenId, WEEK) + total > limit.weeklyMax) return false;
  }
  return true;
}
