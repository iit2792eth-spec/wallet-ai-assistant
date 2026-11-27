import { getSetting } from "@/db/settings";
import { LIMITS } from "./config";

// Slippage for Uniswap swaps. The Settings value applies unless the user typed
// another figure for this request ("swap 1 ETH to USDC with 2% slippage").
// Only the user's own typed messages count: a figure from the model, a pasted
// message or a document is ignored. A typed figure above the Settings value is
// allowed, with no upper limit, but needs a separate "are you sure" approval.

export function settingsSlippageBps(): number {
  const bps = Number(getSetting("swap_slippage_bps"));
  return Number.isInteger(bps) && bps > 0 && bps < 10_000 ? bps : LIMITS.swapDefaultSlippageBps;
}

/** Slippage figures (basis points) written in the user's typed messages next to the word "slippage". */
export function typedSlippages(texts: string[]): number[] {
  const out: number[] = [];
  for (const text of texts) {
    if (!/slippage/i.test(text)) continue;
    for (const m of text.matchAll(/(\d+(?:\.\d{1,2})?)\s*(?:%|percent\b|per\s*cent\b)/gi)) out.push(Math.round(Number(m[1]) * 100));
  }
  return out;
}

/** "0.5%", "2%", "12.25%". */
export const percent = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
