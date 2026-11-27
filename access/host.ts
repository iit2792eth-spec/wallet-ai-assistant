import { isAddress, type Address } from "viem";
import { WalletError, getActivity, getBalance, getWalletStatus, lookupEns, resolveEns, type Token } from "@/wallet";
import { LIMITS } from "./config";
import type { FeeBook } from "./fees";
import { resolveRecipient } from "./recipients";
import { AccessError } from "./types";

// The read functions the program can call (manifest kind "read"). Each one
// checks its input, then calls the Wallet Layer. A refusal is thrown as an
// AccessError, whose message the program sees.

const TOKENS: readonly Token[] = ["ETH", "USDC", "EURC"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function onlyKeys(value: Record<string, unknown>, allowed: string[], fn: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new AccessError(`${fn}: unknown option ${extra.join(", ")}`);
}

export function parseToken(value: unknown, fn: string): Token {
  const token = typeof value === "string" ? value.toUpperCase() : "";
  if (!(TOKENS as readonly string[]).includes(token)) throw new AccessError(`${fn}: token must be one of ${TOKENS.join(", ")}`);
  return token as Token;
}

/** The user's own address, or null if no wallet exists. */
export async function ownAddress(): Promise<Address | null> {
  return ((await getWalletStatus()).address as Address | null) ?? null;
}

/**
 * wallet.getBalance({ token, address? }). Only the user's own wallet: another
 * address is refused here, before any RPC call, so it never reaches a node.
 */
export async function hostGetBalance(options: unknown): Promise<bigint> {
  if (!isRecord(options)) throw new AccessError("wallet.getBalance: pass an object, e.g. { token: \"ETH\" }");
  onlyKeys(options, ["token", "address"], "wallet.getBalance");
  const token = parseToken(options.token, "wallet.getBalance");
  const own = await ownAddress();
  if (!own) throw new AccessError("No wallet is set up yet. Create or import one in Settings.");
  if (options.address !== undefined) {
    const same = typeof options.address === "string" && options.address.toLowerCase() === own.toLowerCase();
    if (!same) throw new AccessError("Only your own wallet's balance can be read.");
  }
  return (await getBalance({ token })).amount;
}

/** wallet.getHistory({ limit?, direction? }): transfers sent through this app, newest first. */
export async function hostGetHistory(options: unknown): Promise<unknown[]> {
  const opts = options === undefined || options === null ? {} : options;
  if (!isRecord(opts)) throw new AccessError("wallet.getHistory: pass an object, e.g. { limit: 5 }");
  onlyKeys(opts, ["limit", "direction"], "wallet.getHistory");
  if (opts.direction !== undefined && opts.direction !== "sent") throw new AccessError('wallet.getHistory: direction can only be "sent"');
  const raw = opts.limit ?? 20;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) throw new AccessError("wallet.getHistory: limit must be a positive whole number");
  const limit = Math.min(raw, LIMITS.maxHistoryLimit);

  const entries = await getActivity({ kind: "transfer", limit: 200 });
  return entries
    .filter((entry) => entry.status === "confirmed" || entry.status === "submitted")
    .slice(0, limit)
    .map((entry) => ({
      to: entry.to,
      toLabel: entry.toLabel,
      token: entry.token,
      amount: entry.amount,
      fee: entry.feeWei,
      timestamp: entry.timestamp,
      txHash: entry.txHash,
      status: entry.status,
    }));
}

/**
 * wallet.estimateFee({ token, to }): the most the network fee for that transfer
 * can be, in wei. The recipient may be an address, ENS name or contact name.
 */
export async function hostEstimateFee(options: unknown, sessionId: string, fees: FeeBook): Promise<bigint> {
  if (!isRecord(options)) throw new AccessError('wallet.estimateFee: pass an object, e.g. { token: "ETH", to }');
  onlyKeys(options, ["token", "to"], "wallet.estimateFee");
  const token = parseToken(options.token, "wallet.estimateFee");
  if (typeof options.to !== "string" || options.to.trim() === "") throw new AccessError("wallet.estimateFee: pass the recipient as to");
  if (!(await ownAddress())) throw new AccessError("No wallet is set up yet. Create or import one in Settings.");
  const recipient = await resolveRecipient(sessionId, options.to.trim());
  if (!recipient.to) throw new AccessError(recipient.problem ?? "The recipient could not be resolved.");
  // The gas of a transfer does not depend on its amount, so one base unit stands in for it.
  // 1 wei, not 0: some nodes under-estimate gas for a zero-value probe.
  return (await fees.get(token, recipient.to, BigInt(1))).maxFeeWei;
}

export function looksLikeEnsName(value: string): boolean {
  return /^[^\s.]+(\.[^\s.]+)+$/.test(value) && value.length <= 255 && !value.startsWith("0x");
}

/** wallet.resolveEns(name) */
export async function hostResolveEns(name: unknown): Promise<Address | null> {
  if (typeof name !== "string" || !looksLikeEnsName(name)) throw new AccessError("wallet.resolveEns: pass an ENS name, e.g. \"name.eth\"");
  return (await resolveEns({ name })).address;
}

/** wallet.lookupEns(address) */
export async function hostLookupEns(address: unknown): Promise<string | null> {
  if (typeof address !== "string" || !isAddress(address, { strict: false })) throw new AccessError("wallet.lookupEns: pass an address");
  return (await lookupEns({ address: address as Address })).name;
}

/** ui.step(text): one plain line for the activity stream. */
export function checkStepText(text: unknown): string {
  if (typeof text !== "string" || text.trim() === "") throw new AccessError("ui.step: pass a short line of text");
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length > LIMITS.maxStepChars) throw new AccessError(`ui.step: at most ${LIMITS.maxStepChars} characters`);
  return line;
}

/** ui.show({ title?, text?, list? }): plain strings only, within size limits. */
export function checkShowContent(content: unknown): { title?: string; text?: string; list?: string[] } {
  if (!isRecord(content)) throw new AccessError("ui.show: pass an object with title, text or list");
  onlyKeys(content, ["title", "text", "list"], "ui.show");
  const { title, text, list } = content;
  if (title !== undefined && (typeof title !== "string" || title.length > LIMITS.maxTitleChars)) {
    throw new AccessError(`ui.show: title must be text of at most ${LIMITS.maxTitleChars} characters`);
  }
  if (text !== undefined && (typeof text !== "string" || text.length > LIMITS.maxTextChars)) {
    throw new AccessError(`ui.show: text must be text of at most ${LIMITS.maxTextChars} characters`);
  }
  if (list !== undefined) {
    const ok =
      Array.isArray(list) &&
      list.length <= LIMITS.maxListItems &&
      list.every((item) => typeof item === "string" && item.length <= LIMITS.maxListItemChars);
    if (!ok) throw new AccessError(`ui.show: list must be at most ${LIMITS.maxListItems} pieces of text`);
  }
  if (title === undefined && text === undefined && list === undefined) throw new AccessError("ui.show: nothing to show");
  return { title: title as string | undefined, text: text as string | undefined, list: list as string[] | undefined };
}

/**
 * wallet.quoteSwap({ tokenIn, tokenOut, amountIn | amountOut }): the best Uniswap
 * quote. Cached for the plan (FeeBook), so the dry run, the real run and the
 * check behind the approval card see the same numbers.
 */
export async function hostQuoteSwap(options: unknown, fees: FeeBook): Promise<{ amountIn: bigint; amountOut: bigint; priceImpact: number }> {
  if (!isRecord(options)) throw new AccessError('wallet.quoteSwap: pass an object, e.g. { tokenIn: "ETH", tokenOut: "USDC", amountIn }');
  onlyKeys(options, ["tokenIn", "tokenOut", "amountIn", "amountOut"], "wallet.quoteSwap");
  const tokenIn = parseToken(options.tokenIn, "wallet.quoteSwap");
  const tokenOut = parseToken(options.tokenOut, "wallet.quoteSwap");
  if (tokenIn === tokenOut) throw new AccessError("wallet.quoteSwap: tokenIn and tokenOut must differ");
  const given = [options.amountIn !== undefined, options.amountOut !== undefined].filter(Boolean).length;
  if (given !== 1) throw new AccessError("wallet.quoteSwap: give exactly one of amountIn or amountOut");
  const amount = options.amountIn ?? options.amountOut;
  if (typeof amount !== "bigint" || amount <= BigInt(0)) throw new AccessError("wallet.quoteSwap: the amount must be a BigInt greater than zero, in base units");
  try {
    const quote = await fees.quote(tokenIn, tokenOut, options.amountIn !== undefined ? "exact_in" : "exact_out", amount);
    return { amountIn: quote.amountIn, amountOut: quote.amountOut, priceImpact: quote.priceImpactBps / 100 };
  } catch (error) {
    if (error instanceof WalletError) throw new AccessError(error.message);
    throw error;
  }
}
