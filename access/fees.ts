import type { Address } from "viem";
import { estimateTransfer, quoteSwap, type EstimateTransferResult, type SwapQuote, type SwapSide, type Token } from "@/wallet";

/**
 * One fee estimate per (token, recipient) for the whole plan. The program's
 * wallet.estimateFee(), the feasibility check and the transaction that is
 * finally sent all use the same numbers, so "balance minus fee" computed by
 * the program is exactly what the check expects and what the transfer costs at most.
 */
export class FeeBook {
  #estimates = new Map<string, Promise<EstimateTransferResult>>();

  get(token: Token, to: Address, amount: bigint): Promise<EstimateTransferResult> {
    const key = `${token}:${to.toLowerCase()}`;
    let estimate = this.#estimates.get(key);
    if (!estimate) {
      estimate = estimateTransfer({ token, to, amount });
      // A failed estimate is not cached: the step is reported as not runnable and may be retried.
      estimate.catch(() => this.#estimates.delete(key));
      this.#estimates.set(key, estimate);
    }
    return estimate;
  }

  #quotes = new Map<string, Promise<SwapQuote>>();

  /**
   * One Uniswap quote per (pair, side, amount) for the whole plan: the program's
   * wallet.quoteSwap() and the check see the same numbers, so the dry run and
   * the real run propose the same actions. Re-quoted just before sending.
   */
  quote(tokenIn: Token, tokenOut: Token, side: SwapSide, amount: bigint): Promise<SwapQuote> {
    const key = `${tokenIn}>${tokenOut}:${side}:${amount}`;
    let quote = this.#quotes.get(key);
    if (!quote) {
      quote = quoteSwap({ tokenIn, tokenOut, side, amount });
      quote.catch(() => this.#quotes.delete(key));
      this.#quotes.set(key, quote);
    }
    return quote;
  }

  /** The cached estimate, if any (used when sending). */
  peek(token: Token, to: Address): Promise<EstimateTransferResult> | undefined {
    return this.#estimates.get(`${token}:${to.toLowerCase()}`);
  }
}
