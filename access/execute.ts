import type { Network } from "@/db/networks";
import type { StepLine } from "@/events/types";
import type { Address } from "viem";
import { formatUnits } from "viem";
import {
  WalletError, buildSwapCall, estimateSwap, getWalletStatus, pendingNonce, quoteSwap, sendSwap, signSwapPermit, signTypedData,
  submitTransfer, transfer, waitForTransfer, type SubmittedTransfer, type TransferResult,
} from "@/wallet";
import { LIMITS } from "./config";
import { updateStep } from "./record";
import { describeStep } from "./templates";
import type { FeeBook } from "./fees";
import type { Step, SwapStep } from "./types";

// Carries out approved steps through the Wallet Layer: one at a time
// (executeStep), or a review batch at once (executeBatch): every transfer in the
// batch is sent with consecutive nonces, then all are awaited together.

export type StepResult = {
  index: number;
  status: "confirmed" | "submitted" | "signed" | "failed" | "skipped";
  txHash?: string;
  /** Wallet error code, never a private detail. */
  error?: string;
  /** Swaps: what arrived. */
  amountOut?: bigint;
};

export type ExecutedStep = { result: StepResult; line: StepLine };

/** Runs one approved step and records the outcome. Never throws. */
export async function executeStep(step: Step, rowId: number | null, network: Network, fees?: FeeBook): Promise<ExecutedStep> {
  const text = describeStep(step, network);
  try {
    if (step.kind === "transfer") {
      const estimate = await fees?.peek(step.token, step.to!)?.catch(() => undefined);
      const sent = await transfer({
        token: step.token,
        to: step.to!,
        amount: step.amount,
        fees: estimate && { gas: estimate.gas, maxFeePerGas: estimate.maxFeePerGas, maxPriorityFeePerGas: estimate.maxPriorityFeePerGas },
      });
      const link = sent.explorerUrl ?? undefined;
      if (sent.status === "reverted") {
        updateStep(rowId, { status: "failed", txHash: sent.hash, blockNumber: sent.blockNumber, feeWei: sent.feeWei, error: "Reverted on chain" });
        return {
          result: { index: step.index, status: "failed", txHash: sent.hash, error: "TRANSFER_REVERTED" },
          line: { text, state: "failed", detail: "The transaction was mined but failed. The network fee was still paid.", link },
        };
      }
      if (sent.status === "pending") {
        updateStep(rowId, { status: "submitted", txHash: sent.hash });
        return {
          result: { index: step.index, status: "submitted", txHash: sent.hash },
          line: { text, state: "pending", detail: "Sent, not yet confirmed.", link },
        };
      }
      updateStep(rowId, { status: "confirmed", txHash: sent.hash, blockNumber: sent.blockNumber, feeWei: sent.feeWei });
      return { result: { index: step.index, status: "confirmed", txHash: sent.hash }, line: { text, state: "done", link } };
    }

    if (step.kind === "swap") return await executeSwap(step, rowId, network);
    const signed = await signTypedData({ typedData: step.typedData! });
    updateStep(rowId, { status: "signed" });
    // The signature is shown to the user once; it is never stored, logged, or given to the program.
    return { result: { index: step.index, status: "signed" }, line: { text, state: "done", detail: `Signature: ${signed.signature}` } };
  } catch (error) {
    const code = error instanceof WalletError ? error.code : "UNKNOWN";
    const message = error instanceof WalletError ? error.message : "Something went wrong.";
    updateStep(rowId, { status: "failed", error: message });
    return { result: { index: step.index, status: "failed", error: code }, line: { text, state: "failed", detail: message } };
  }
}

export function skippedStep(step: Step, network: Network, rowId: number | null, reason: string): ExecutedStep {
  updateStep(rowId, { status: "skipped", error: reason });
  return { result: { index: step.index, status: "skipped", error: "SKIPPED" }, line: { text: describeStep(step, network), state: "skipped", detail: reason } };
}

/**
 * Sends one approved swap and waits for it. Just before sending it is quoted
 * again on the same pool: if the price got worse than the limit the user
 * approved, nothing is sent. The limit itself never changes after approval.
 * A token paid in is allowed with a permit for exactly the most that may be
 * paid, signed now and used inside the same transaction: no allowance remains.
 */
export async function executeSwap(step: SwapStep, rowId: number | null, network: Network): Promise<ExecutedStep> {
  const text = describeStep(step, network);
  const fail = (detail: string, code: string): ExecutedStep => {
    updateStep(rowId, { status: "failed", error: detail });
    return { result: { index: step.index, status: "failed", error: code }, line: { text, state: "failed", detail } };
  };
  try {
    const fresh = await quoteSwap({ tokenIn: step.tokenIn, tokenOut: step.tokenOut, side: step.side, amount: step.side === "exact_in" ? step.amountIn : step.amountOut, fees: [step.feeTier!] });
    if (step.side === "exact_in" && fresh.amountOut < step.minOut) {
      return fail(
        `The price moved: this swap would now return ${formatUnits(fresh.amountOut, step.decimalsOut)} ${step.tokenOut}, below the ${formatUnits(step.minOut, step.decimalsOut)} you approved. Nothing was sent; ask again for a new quote.`,
        "PRICE_MOVED",
      );
    }
    if (step.side === "exact_out" && fresh.amountIn > step.maxIn) {
      return fail(
        `The price moved: this swap would now cost ${formatUnits(fresh.amountIn, step.decimalsIn)} ${step.tokenIn}, above the ${formatUnits(step.maxIn, step.decimalsIn)} you approved. Nothing was sent; ask again for a new quote.`,
        "PRICE_MOVED",
      );
    }
    const owner = (await getWalletStatus()).address as Address;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + LIMITS.swapDeadlineSeconds);
    const permit = step.tokenIn === "ETH" ? undefined : await signSwapPermit({ token: step.tokenIn, value: step.maxIn, deadline });
    const call = buildSwapCall({
      network,
      quote: { tokenIn: step.tokenIn, tokenOut: step.tokenOut, side: step.side, fee: step.feeTier!, amountIn: step.amountIn, amountOut: step.amountOut },
      limit: step.side === "exact_in" ? step.minOut : step.maxIn,
      owner,
      deadline,
      permit,
    });
    let gas;
    try {
      gas = await estimateSwap(call);
    } catch (error) {
      if (error instanceof WalletError && error.code === "TRANSFER_REVERTED") {
        return fail("The swap would fail on chain right now (the price or the pool changed). Nothing was sent.", "SWAP_WOULD_REVERT");
      }
      throw error;
    }
    // A little headroom over the node's estimate, never above the default limit the fee shown was based on.
    const padded = (gas.gas * BigInt(12)) / BigInt(10);
    const limit = BigInt(LIMITS.swapFallbackGas);
    const sent = await sendSwap({ call, tokenOut: step.tokenOut, gas: { ...gas, gas: padded > limit && gas.gas <= limit ? limit : padded } });
    const link = sent.explorerUrl ?? undefined;
    if (sent.status === "reverted") {
      updateStep(rowId, { status: "failed", txHash: sent.hash, blockNumber: sent.blockNumber, feeWei: sent.feeWei, error: "Reverted on chain" });
      return {
        result: { index: step.index, status: "failed", txHash: sent.hash, error: "SWAP_REVERTED" },
        line: { text, state: "failed", detail: "The swap was mined but failed (the price moved past your limit, or the deadline passed). Your tokens stayed with you; the network fee was paid.", link },
      };
    }
    if (sent.status === "pending") {
      updateStep(rowId, { status: "submitted", txHash: sent.hash });
      return { result: { index: step.index, status: "submitted", txHash: sent.hash, error: "SWAP_PENDING" }, line: { text, state: "pending", detail: "Sent, not yet confirmed.", link } };
    }
    updateStep(rowId, { status: "confirmed", txHash: sent.hash, blockNumber: sent.blockNumber, feeWei: sent.feeWei, amountOut: sent.amountOut });
    const received = sent.amountOut === null ? undefined : `Received ${formatUnits(sent.amountOut, step.decimalsOut)} ${step.tokenOut}.`;
    return { result: { index: step.index, status: "confirmed", txHash: sent.hash, amountOut: sent.amountOut ?? undefined }, line: { text, state: "done", detail: received, link } };
  } catch (error) {
    return failedOutcome(step, rowId, network, error);
  }
}

/** Turns a mined (or timed-out) transfer into a step outcome and records it. */
function transferOutcome(step: Step, rowId: number | null, network: Network, sent: TransferResult): ExecutedStep {
  const text = describeStep(step, network);
  const link = sent.explorerUrl ?? undefined;
  if (sent.status === "reverted") {
    updateStep(rowId, { status: "failed", txHash: sent.hash, blockNumber: sent.blockNumber, feeWei: sent.feeWei, error: "Reverted on chain" });
    return {
      result: { index: step.index, status: "failed", txHash: sent.hash, error: "TRANSFER_REVERTED" },
      line: { text, state: "failed", detail: "The transaction was mined but failed. The network fee was still paid.", link },
    };
  }
  if (sent.status === "pending") {
    updateStep(rowId, { status: "submitted", txHash: sent.hash });
    return { result: { index: step.index, status: "submitted", txHash: sent.hash }, line: { text, state: "pending", detail: "Sent, not yet confirmed.", link } };
  }
  updateStep(rowId, { status: "confirmed", txHash: sent.hash, blockNumber: sent.blockNumber, feeWei: sent.feeWei });
  return { result: { index: step.index, status: "confirmed", txHash: sent.hash }, line: { text, state: "done", link } };
}

function failedOutcome(step: Step, rowId: number | null, network: Network, error: unknown): ExecutedStep {
  const code = error instanceof WalletError ? error.code : "UNKNOWN";
  const message = error instanceof WalletError ? error.message : "Something went wrong.";
  updateStep(rowId, { status: "failed", error: message });
  return { result: { index: step.index, status: "failed", error: code }, line: { text: describeStep(step, network), state: "failed", detail: message } };
}

/**
 * Runs the approved steps of one review batch, in order. Transfers are sent one
 * after another without waiting for each to be mined (consecutive nonces from
 * pendingNonce), then all are awaited together. If a transfer cannot be sent,
 * the rest of the batch is not sent (a later nonce could not be mined anyway);
 * transfers already sent stay sent. Never throws.
 */
export async function executeBatch(
  items: { step: Step; rowId: number | null }[],
  network: Network,
  fees?: FeeBook,
  options: { waitMs?: number } = {},
): Promise<ExecutedStep[]> {
  const outcomes = new Map<number, ExecutedStep>();
  const inFlight: { step: Step; rowId: number | null; sent: SubmittedTransfer }[] = [];
  let nonce: number | null = null;
  let stopped = false;

  // Transfers already sent are waited for before a swap (a barrier), so later steps see real balances.
  const flush = async () => {
    await Promise.all(
      inFlight.splice(0).map(async ({ step, rowId, sent }) => {
        try {
          outcomes.set(step.index, transferOutcome(step, rowId, network, await waitForTransfer(sent, options.waitMs)));
        } catch {
          updateStep(rowId, { status: "submitted", txHash: sent.hash });
          outcomes.set(step.index, {
            result: { index: step.index, status: "submitted", txHash: sent.hash },
            line: { text: describeStep(step, network), state: "pending", detail: "Sent, not yet confirmed.", link: sent.explorerUrl ?? undefined },
          });
        }
      }),
    );
  };

  for (const { step, rowId } of items) {
    if (stopped) {
      outcomes.set(step.index, skippedStep(step, network, rowId, "Not sent, because an earlier step in this batch could not be completed."));
      continue;
    }
    if (step.kind === "swap") {
      await flush();
      if ([...outcomes.values()].some((o) => o.result.status === "failed")) {
        stopped = true;
        outcomes.set(step.index, skippedStep(step, network, rowId, "Not sent, because an earlier step in this batch failed."));
        continue;
      }
      const outcome = await executeSwap(step, rowId, network);
      outcomes.set(step.index, outcome);
      // Later steps may spend what the swap buys: only go on once it is confirmed.
      if (outcome.result.status !== "confirmed") stopped = true;
      nonce = null;
      continue;
    }
    if (step.kind !== "transfer") {
      outcomes.set(step.index, await executeStep(step, rowId, network, fees));
      if (outcomes.get(step.index)!.result.status === "failed") stopped = true;
      continue;
    }
    try {
      nonce ??= await pendingNonce();
      const estimate = await fees?.peek(step.token, step.to!)?.catch(() => undefined);
      const sent = await submitTransfer({
        token: step.token,
        to: step.to!,
        amount: step.amount,
        nonce,
        fees: estimate && { gas: estimate.gas, maxFeePerGas: estimate.maxFeePerGas, maxPriorityFeePerGas: estimate.maxPriorityFeePerGas },
      });
      nonce += 1;
      updateStep(rowId, { status: "submitted", txHash: sent.hash });
      inFlight.push({ step, rowId, sent });
    } catch (error) {
      outcomes.set(step.index, failedOutcome(step, rowId, network, error));
      stopped = true;
    }
  }

  // Sent, but a receipt that cannot be read is reported as sent, not as failed.
  await flush();
  return items.map(({ step }) => outcomes.get(step.index)!);
}
