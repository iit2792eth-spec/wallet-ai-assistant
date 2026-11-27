import { encodeFunctionData, erc20Abi, formatUnits, parseEventLogs, parseSignature, WaitForTransactionReceiptTimeoutError, type Address, type Hex } from "viem";
import { getDb } from "@/db";
import type { Network } from "@/db/networks";
import { activeNetwork, publicClientFor, walletClientFor } from "./clients";
import { WalletError, toWalletError } from "./errors";
import { requireUnlockedAccount, walletAddress } from "./keystore";
import { shortHash, walletLog } from "./log";

// Uniswap v3 swaps through SwapRouter02, quoted with QuoterV2. Contract
// addresses come from the dex_contracts table, never from a caller.
//
// This module only reads chain data, builds the router call it is asked for
// and sends it. What to swap, the least to accept and the deadline are decided
// by the access layer; the recipient is always the user's own wallet, fixed here.

export type SwapToken = { symbol: string; address: Address | null; decimals: number };
export type SwapSide = "exact_in" | "exact_out";

/** Fee tiers tried for every quote: 0.01%, 0.05%, 0.3%, 1% (in hundredths of a basis point). */
export const FEE_TIERS = [100, 500, 3000, 10000] as const;

/** SwapRouter02's stand-in for "the router itself" (Constants.ADDRESS_THIS): output goes there before unwrapping to ETH. */
const ROUTER_ITSELF = "0x0000000000000000000000000000000000000002" as const;

type DexContracts = { router: Address; quoter: Address; factory: Address; weth: Address };

export function dexContracts(network: Network): DexContracts {
  let row: DexContracts | undefined;
  try {
    row = getDb().prepare("SELECT router, quoter, factory, weth FROM dex_contracts WHERE chain_id = ?").get(network.chainId) as DexContracts | undefined;
  } catch (error) {
    // The table arrives with database version 3, applied when the app starts: a server started
    // before the upgrade still has the old database open.
    if (error instanceof Error && /no such table/i.test(error.message)) {
      throw new WalletError("DEX_NOT_CONFIGURED", { cause: error, message: "Swaps are not set up in the database yet. Restart the app so it can upgrade the database, then try again." });
    }
    throw error;
  }
  if (!row) throw new WalletError("DEX_NOT_CONFIGURED");
  return row;
}

const swapToken = (network: Network, symbol: string): SwapToken => {
  const row = getDb()
    .prepare("SELECT symbol, address, decimals FROM tokens WHERE chain_id = ? AND symbol = ? COLLATE NOCASE")
    .get(network.chainId, symbol) as { symbol: string; address: string | null; decimals: number } | undefined;
  if (!row) throw new WalletError("TOKEN_NOT_CONFIGURED");
  return { symbol: row.symbol, address: row.address as Address | null, decimals: row.decimals };
};

// ---- ABIs (only what is used) ----

const quoterAbi = [
  {
    type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" },
      { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" }],
  },
  {
    type: "function", name: "quoteExactOutputSingle", stateMutability: "nonpayable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amount", type: "uint256" },
      { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
    outputs: [{ name: "amountIn", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" }],
  },
] as const;

const factoryAbi = [
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
] as const;

const poolAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [{ name: "sqrtPriceX96", type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }],
  },
] as const;

const routerAbi = [
  {
    type: "function", name: "exactInputSingle", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" },
      { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function", name: "exactOutputSingle", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" },
      { name: "recipient", type: "address" }, { name: "amountOut", type: "uint256" }, { name: "amountInMaximum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" }] }],
    outputs: [{ name: "amountIn", type: "uint256" }],
  },
  { type: "function", name: "multicall", stateMutability: "payable", inputs: [{ name: "deadline", type: "uint256" }, { name: "data", type: "bytes[]" }], outputs: [{ type: "bytes[]" }] },
  { type: "function", name: "unwrapWETH9", stateMutability: "payable", inputs: [{ name: "amountMinimum", type: "uint256" }, { name: "recipient", type: "address" }], outputs: [] },
  { type: "function", name: "refundETH", stateMutability: "payable", inputs: [], outputs: [] },
  {
    type: "function", name: "selfPermit", stateMutability: "payable",
    inputs: [{ name: "token", type: "address" }, { name: "value", type: "uint256" }, { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }],
    outputs: [],
  },
] as const;

const wethAbi = [{ type: "event", name: "Withdrawal", inputs: [{ name: "src", type: "address", indexed: true }, { name: "wad", type: "uint256", indexed: false }] }] as const;

// ---- Quotes ----

export type SwapQuote = {
  tokenIn: string;
  tokenOut: string;
  side: SwapSide;
  /** The pool's fee tier. */
  fee: number;
  pool: Address;
  /** Exact for exact_in; quoted for exact_out. Base units. */
  amountIn: bigint;
  /** Quoted for exact_in; exact for exact_out. Base units. */
  amountOut: bigint;
  /** How far the trade moves the price against you, beyond the pool fee, in basis points. */
  priceImpactBps: number;
  /** The quoter's own gas estimate for the swap. */
  gasEstimate: bigint;
};

const Q192 = BigInt(2) ** BigInt(192);

/**
 * Price impact in basis points: 1 - (execution price) / (pool price after the fee).
 * Prices in raw units, so decimals cancel. `inIsToken0` says which way the pool's price reads.
 */
export function priceImpactBps(amountIn: bigint, amountOut: bigint, sqrtPriceX96: bigint, inIsToken0: boolean, fee: number): number {
  if (amountIn <= BigInt(0) || sqrtPriceX96 <= BigInt(0)) return 10_000;
  const P2 = sqrtPriceX96 * sqrtPriceX96;
  const scale = BigInt(1_000_000);
  // ratio = (amountOut / amountIn) / spot, scaled by 1e6, then divided by (1 - fee).
  const ratio = inIsToken0 ? (amountOut * Q192 * scale) / (amountIn * P2) : (amountOut * P2 * scale) / (amountIn * Q192);
  const afterFee = (ratio * scale) / (scale - BigInt(fee));
  const impactPpm = Number(scale - afterFee);
  return Math.max(0, Math.round(impactPpm / 100));
}

/**
 * The best quote across every fee tier: the most out for an exact input, or the
 * least in for an exact output. ETH is quoted as WETH (the router wraps it).
 * Throws NO_SWAP_ROUTE if no pool can quote the amount, DEX_NOT_CONFIGURED, TOKEN_NOT_CONFIGURED, RPC_*.
 */
export async function quoteSwap(input: { tokenIn: string; tokenOut: string; side: SwapSide; amount: bigint; fees?: readonly number[] }): Promise<SwapQuote> {
  const detail = { tokenIn: input.tokenIn, tokenOut: input.tokenOut, side: input.side, amount: input.amount.toString() };
  const started = Date.now();
  try {
    const network = activeNetwork();
    const dex = dexContracts(network);
    const tin = swapToken(network, input.tokenIn);
    const tout = swapToken(network, input.tokenOut);
    const addrIn = tin.address ?? dex.weth;
    const addrOut = tout.address ?? dex.weth;
    if (addrIn.toLowerCase() === addrOut.toLowerCase()) throw new WalletError("NO_SWAP_ROUTE");
    const client = publicClientFor(network);

    const attempts = await Promise.all(
      (input.fees ?? FEE_TIERS).map(async (fee) => {
        try {
          const { result } =
            input.side === "exact_in"
              ? await client.simulateContract({ address: dex.quoter, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: addrIn, tokenOut: addrOut, amountIn: input.amount, fee, sqrtPriceLimitX96: BigInt(0) }] })
              : await client.simulateContract({ address: dex.quoter, abi: quoterAbi, functionName: "quoteExactOutputSingle", args: [{ tokenIn: addrIn, tokenOut: addrOut, amount: input.amount, fee, sqrtPriceLimitX96: BigInt(0) }] });
          const [amount, , , gasEstimate] = result;
          if (amount <= BigInt(0)) return null;
          return { fee, amount, gasEstimate };
        } catch (error) {
          // A tier with no pool or not enough liquidity simply has no quote; a network failure does matter.
          const walletError = toWalletError(error);
          if (walletError.code === "RPC_UNAVAILABLE") throw walletError;
          return null;
        }
      }),
    );
    const quotes = attempts.filter((q): q is NonNullable<typeof q> => q !== null);
    if (quotes.length === 0) throw new WalletError("NO_SWAP_ROUTE");
    const best = quotes.reduce((a, b) => (input.side === "exact_in" ? (b.amount > a.amount ? b : a) : b.amount < a.amount ? b : a));

    const pool = (await client.readContract({ address: dex.factory, abi: factoryAbi, functionName: "getPool", args: [addrIn, addrOut, best.fee] })) as Address;
    const [slot0, token0] = await Promise.all([
      client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
      client.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
    ]);
    const amountIn = input.side === "exact_in" ? input.amount : best.amount;
    const amountOut = input.side === "exact_in" ? best.amount : input.amount;
    const quote: SwapQuote = {
      tokenIn: tin.symbol, tokenOut: tout.symbol, side: input.side, fee: best.fee, pool,
      amountIn, amountOut,
      priceImpactBps: priceImpactBps(amountIn, amountOut, slot0[0], (token0 as string).toLowerCase() === addrIn.toLowerCase(), best.fee),
      gasEstimate: best.gasEstimate,
    };
    walletLog("quote_swap_ok", { ...detail, fee: quote.fee, impactBps: quote.priceImpactBps, tiers: quotes.length, ms: Date.now() - started });
    return quote;
  } catch (error) {
    const walletError = toWalletError(error);
    walletLog("quote_swap_failed", { ...detail, code: walletError.code, ms: Date.now() - started });
    throw walletError;
  }
}

// ---- The router call ----

export type SwapPermit = { value: bigint; deadline: bigint; v: number; r: Hex; s: Hex };
export type SwapCall = { to: Address; data: Hex; value: bigint };

/**
 * Builds SwapRouter02.multicall(deadline, [...]) for one single-pool swap:
 *   [selfPermit] (token in, when a permit is given) -> exactInputSingle / exactOutputSingle
 *   -> unwrapWETH9 (ETH out) / refundETH (ETH in, exact output: return what was not needed).
 * `limit` is the least to receive (exact_in) or the most to pay (exact_out).
 * The output always goes to `owner` (the user's own wallet).
 */
export function buildSwapCall(input: {
  network: Network;
  quote: Pick<SwapQuote, "tokenIn" | "tokenOut" | "side" | "fee" | "amountIn" | "amountOut">;
  limit: bigint;
  owner: Address;
  deadline: bigint;
  permit?: SwapPermit;
}): SwapCall {
  const { network, quote, limit, owner, deadline, permit } = input;
  const dex = dexContracts(network);
  const tin = swapToken(network, quote.tokenIn);
  const tout = swapToken(network, quote.tokenOut);
  const ethIn = tin.address === null;
  const ethOut = tout.address === null;
  const tokenIn = tin.address ?? dex.weth;
  const tokenOut = tout.address ?? dex.weth;
  const recipient = ethOut ? ROUTER_ITSELF : owner;
  const calls: Hex[] = [];

  if (permit && !ethIn) {
    calls.push(encodeFunctionData({ abi: routerAbi, functionName: "selfPermit", args: [tokenIn, permit.value, permit.deadline, permit.v, permit.r, permit.s] }));
  }
  if (quote.side === "exact_in") {
    calls.push(encodeFunctionData({ abi: routerAbi, functionName: "exactInputSingle", args: [{ tokenIn, tokenOut, fee: quote.fee, recipient, amountIn: quote.amountIn, amountOutMinimum: limit, sqrtPriceLimitX96: BigInt(0) }] }));
    if (ethOut) calls.push(encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [limit, owner] }));
  } else {
    calls.push(encodeFunctionData({ abi: routerAbi, functionName: "exactOutputSingle", args: [{ tokenIn, tokenOut, fee: quote.fee, recipient, amountOut: quote.amountOut, amountInMaximum: limit, sqrtPriceLimitX96: BigInt(0) }] }));
    if (ethOut) calls.push(encodeFunctionData({ abi: routerAbi, functionName: "unwrapWETH9", args: [quote.amountOut, owner] }));
    if (ethIn) calls.push(encodeFunctionData({ abi: routerAbi, functionName: "refundETH", args: [] }));
  }
  const value = ethIn ? (quote.side === "exact_in" ? quote.amountIn : limit) : BigInt(0);
  return { to: dex.router, data: encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [deadline, calls] }), value };
}

/**
 * Signs an EIP-2612 permit letting the router take exactly `value` of `token`
 * until `deadline`, for use inside the same swap transaction (selfPermit), so
 * no allowance is left behind. Needs the wallet to be unlocked.
 */
export async function signSwapPermit(input: { token: string; value: bigint; deadline: bigint }): Promise<SwapPermit> {
  const network = activeNetwork();
  const dex = dexContracts(network);
  const { getPermitData, signTypedData } = await import("./index");
  const data = await getPermitData({ token: input.token as never });
  const { signature } = await signTypedData({
    typedData: {
      domain: { name: data.name, version: data.version, chainId: data.chainId, verifyingContract: data.verifyingContract },
      types: {
        Permit: [
          { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: { owner: data.owner, spender: dex.router, value: input.value, nonce: data.nonce, deadline: input.deadline },
    },
  });
  const { v, r, s, yParity } = parseSignature(signature);
  return { value: input.value, deadline: input.deadline, v: Number(v ?? BigInt(yParity + 27)), r, s };
}

export type SwapGas = { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; maxFeeWei: bigint };

/** Gas and the worst-case fee for a swap call, from the node. Throws INSUFFICIENT_FUNDS, TRANSFER_REVERTED, RPC_*. */
export async function estimateSwap(call: SwapCall): Promise<SwapGas> {
  const started = Date.now();
  try {
    const network = activeNetwork();
    const client = publicClientFor(network);
    const [gas, fees] = await Promise.all([client.estimateGas({ account: await walletAddress(), to: call.to, data: call.data, value: call.value }), client.estimateFeesPerGas()]);
    const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? BigInt(0);
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? maxFeePerGas;
    walletLog("estimate_swap_ok", { ms: Date.now() - started });
    return { gas, maxFeePerGas, maxPriorityFeePerGas, maxFeeWei: gas * maxFeePerGas };
  } catch (error) {
    const walletError = toWalletError(error);
    walletLog("estimate_swap_failed", { code: walletError.code, ms: Date.now() - started });
    throw walletError;
  }
}

/** Current fee rates, for a swap whose gas cannot be estimated yet (a token permit not signed yet). */
export async function feeRates(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  try {
    const fees = await publicClientFor(activeNetwork()).estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? BigInt(0);
    return { maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? maxFeePerGas };
  } catch (error) {
    throw toWalletError(error);
  }
}

export type SwapResult = {
  status: "confirmed" | "reverted" | "pending";
  hash: Hex;
  explorerUrl: string | null;
  blockNumber: bigint | null;
  feeWei: bigint | null;
  /** What arrived in the wallet, read from the receipt's logs; null if not mined or not found. */
  amountOut: bigint | null;
};

/**
 * Signs and sends a swap call, waits up to `waitMs` for it to be mined, and
 * reads what arrived from the receipt. Throws WALLET_LOCKED, INSUFFICIENT_FUNDS, NONCE_CONFLICT, RPC_*.
 * A swap that is mined and fails (e.g. the price moved past the limit) is returned as "reverted".
 */
export async function sendSwap(input: { call: SwapCall; tokenOut: string; gas?: SwapGas; nonce?: number; waitMs?: number }): Promise<SwapResult> {
  const started = Date.now();
  try {
    const network = activeNetwork();
    const account = requireUnlockedAccount();
    const dex = dexContracts(network);
    const tout = swapToken(network, input.tokenOut);
    const hash = await walletClientFor(network, account).sendTransaction({
      to: input.call.to,
      data: input.call.data,
      value: input.call.value,
      ...(input.gas ? { gas: input.gas.gas, maxFeePerGas: input.gas.maxFeePerGas, maxPriorityFeePerGas: input.gas.maxPriorityFeePerGas } : {}),
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
    });
    walletLog("swap_sent", { tx: shortHash(hash) });
    const explorerUrl = network.explorerUrl ? `${network.explorerUrl}/tx/${hash}` : null;
    try {
      const receipt = await publicClientFor(network).waitForTransactionReceipt({ hash, timeout: input.waitMs ?? 120_000 });
      let amountOut: bigint | null = null;
      if (receipt.status === "success") {
        if (tout.address) {
          const logs = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs.filter((l) => l.address.toLowerCase() === tout.address!.toLowerCase()) });
          const mine = logs.filter((l) => l.args.to.toLowerCase() === account.address.toLowerCase());
          if (mine.length) amountOut = mine.reduce((sum, l) => sum + l.args.value, BigInt(0));
        } else {
          const logs = parseEventLogs({ abi: wethAbi, eventName: "Withdrawal", logs: receipt.logs.filter((l) => l.address.toLowerCase() === dex.weth.toLowerCase()) });
          if (logs.length) amountOut = logs.reduce((sum, l) => sum + l.args.wad, BigInt(0));
        }
      }
      walletLog("swap_ok", { tx: shortHash(hash), status: receipt.status, amountOut: amountOut === null ? null : formatUnits(amountOut, tout.decimals), ms: Date.now() - started });
      return {
        status: receipt.status === "success" ? "confirmed" : "reverted",
        hash, explorerUrl, blockNumber: receipt.blockNumber, feeWei: receipt.gasUsed * receipt.effectiveGasPrice, amountOut,
      };
    } catch (error) {
      if (error instanceof WaitForTransactionReceiptTimeoutError) return { status: "pending", hash, explorerUrl, blockNumber: null, feeWei: null, amountOut: null };
      throw error;
    }
  } catch (error) {
    const walletError = toWalletError(error);
    walletLog("swap_failed", { code: walletError.code, ms: Date.now() - started });
    throw walletError;
  }
}
