import { decodeAbiParameters, encodeAbiParameters, encodeEventTopics, erc20Abi, padHex, type Hex } from "viem";

// A fake Uniswap v3 on Sepolia for the fake RPC node (tests/helpers/fake-rpc.ts):
// QuoterV2 quotes, factory.getPool, pool.slot0/token0, plus the token reads the
// rest of the app makes (name, version, nonces, balanceOf). No request leaves the machine.
//
// Prices: 1 ETH = 50,000 USDC. Fee tiers 0.01% / 0.05% / 0.3% / 1%; the 0.05% pool
// quotes best (the others lose a little extra), so the best-quote choice is visible.
// Only WETH/USDC has pools: any other pair has no quote.

export const UNI = {
  router: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  quoter: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
  factory: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
  weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
} as const;

const SELECTOR = {
  quoteIn: "0xc6a5026a",
  quoteOut: "0xbd21704a",
  getPool: "0x1698ee82",
  slot0: "0x3850c7bd",
  token0: "0x0dfe1681",
  name: "0x06fdde03",
  version: "0x54fd4d50",
  nonces: "0x7ecebe00",
} as const;

/** Extra loss per fee tier, in parts per million, on top of the pool fee. */
const EXTRA_PPM: Record<number, number> = { 100: 20_000, 500: 0, 3000: 1_000, 10000: 0 };
const PPM = BigInt(1_000_000);
const USDC_PER_ETH = BigInt(50_000);

const poolAddress = (fee: number) => padHex(`0x${fee.toString(16)}`, { size: 20 });
function isqrt(n: bigint): bigint {
  if (n < BigInt(2)) return n;
  let x = n;
  let y = (x + BigInt(1)) / BigInt(2);
  while (y < x) {
    x = y;
    y = (x + n / x) / BigInt(2);
  }
  return x;
}
/** USDC (token0) / WETH (token1): price = WETH wei per USDC unit = 1e18 / (50,000 * 1e6). */
const SQRT_PRICE_X96 = isqrt((BigInt(10) ** BigInt(18) * (BigInt(2) ** BigInt(192))) / (USDC_PER_ETH * BigInt(10) ** BigInt(6)));

export type FakeUniswap = {
  /** Extra loss (ppm) applied to every quote, e.g. 150_000 for a 15% price impact. */
  extraPpm: number;
  /** Quotes made so far. */
  quotes: number;
};

/** An eth_call handler for the fake RPC: Uniswap reads plus the token reads, and 25 of any token for balanceOf. */
export function uniswapCall(state: FakeUniswap) {
  return (params: unknown[]): Hex => {
    const call = params[0] as { to: string; data?: string; input?: string };
    const data = (call.data ?? call.input ?? "") as Hex;
    const selector = data.slice(0, 10);
    const to = call.to.toLowerCase();
    if (to === UNI.quoter.toLowerCase() && (selector === SELECTOR.quoteIn || selector === SELECTOR.quoteOut)) {
      state.quotes += 1;
      const [tokenIn, tokenOut, amount, fee] = decodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint24" }, { type: "uint160" }],
        `0x${data.slice(10)}` as Hex,
      );
      const pair = [tokenIn.toLowerCase(), tokenOut.toLowerCase()].sort().join();
      if (pair !== [UNI.weth.toLowerCase(), UNI.usdc.toLowerCase()].sort().join()) throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
      const keep = (PPM - BigInt(fee)) * (PPM - BigInt(EXTRA_PPM[fee] ?? 0)) * (PPM - BigInt(state.extraPpm));
      const ethIn = tokenIn.toLowerCase() === UNI.weth.toLowerCase();
      // Base-unit rate: USDC per wei = 50,000e6 / 1e18.
      const num = ethIn ? USDC_PER_ETH * BigInt(10) ** BigInt(6) : BigInt(10) ** BigInt(18);
      const den = ethIn ? BigInt(10) ** BigInt(18) : USDC_PER_ETH * BigInt(10) ** BigInt(6);
      const result =
        selector === SELECTOR.quoteIn
          ? (amount * num * keep) / (den * PPM * PPM * PPM)
          : (amount * den * PPM * PPM * PPM + num * keep - BigInt(1)) / (num * keep);
      return encodeAbiParameters([{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }], [result, SQRT_PRICE_X96, 1, BigInt(120_000)]);
    }
    if (to === UNI.factory.toLowerCase() && selector === SELECTOR.getPool) {
      const [, , fee] = decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }], `0x${data.slice(10)}` as Hex);
      return encodeAbiParameters([{ type: "address" }], [poolAddress(fee)]);
    }
    if (selector === SELECTOR.slot0) {
      return encodeAbiParameters(
        [{ type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" }],
        [SQRT_PRICE_X96, 0, 0, 0, 0, 0, true],
      );
    }
    if (selector === SELECTOR.token0) return encodeAbiParameters([{ type: "address" }], [UNI.usdc]);
    if (selector === SELECTOR.name) return encodeAbiParameters([{ type: "string" }], ["USDC"]);
    if (selector === SELECTOR.version) return encodeAbiParameters([{ type: "string" }], ["2"]);
    if (selector === SELECTOR.nonces) return encodeAbiParameters([{ type: "uint256" }], [BigInt(3)]);
    return `0x${(25_000_000).toString(16).padStart(64, "0")}`; // balanceOf: 25 of the token (6 decimals)
  };
}

/** A receipt log: `amount` of USDC transferred to `to` (what the swap delivered). */
export function usdcTransferLog(to: string, amount: bigint) {
  return {
    address: UNI.usdc,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: poolAddress(500), to: to as Hex } }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    blockNumber: "0x11", transactionHash: `0x${"cd".repeat(32)}`, transactionIndex: "0x0", blockHash: `0x${"ab".repeat(32)}`, logIndex: "0x0", removed: false,
  };
}

/** A receipt log: WETH unwrapped by the router (what an ETH-out swap delivered). */
export function wethWithdrawalLog(amount: bigint) {
  return {
    address: UNI.weth,
    topics: [
      "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65",
      padHex(UNI.router.toLowerCase() as Hex, { size: 32 }),
    ],
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    blockNumber: "0x11", transactionHash: `0x${"cd".repeat(32)}`, transactionIndex: "0x0", blockHash: `0x${"ab".repeat(32)}`, logIndex: "0x0", removed: false,
  };
}
