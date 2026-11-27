import { rmSync } from "node:fs";
import { decodeFunctionData, parseAbi, parseTransaction, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPlan } from "@/access";
import { getDb } from "@/db";
import { assessSteps } from "@/lib/feasibility";
import { lockWallet, priceImpactBps } from "@/wallet";
import { setTransportFactoryForTests } from "@/wallet/clients";
import { fakeRpc } from "../helpers/fake-rpc";
import { UNI, uniswapCall, usdcTransferLog, wethWithdrawalLog, type FakeUniswap } from "../helpers/fake-uniswap";
import { ALICE, OWN, decoded, newSession, resetDatabase, setLimit, setupWallet, userTyped, watch } from "./helpers";

// Uniswap swaps through the real access layer and wallet code, against a fake
// node and a fake Uniswap (tests/helpers/fake-uniswap.ts: 1 ETH = 50,000 USDC,
// the 0.05% pool quotes best).

const router = parseAbi([
  "function multicall(uint256 deadline, bytes[] data)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))",
  "function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96))",
  "function unwrapWETH9(uint256 amountMinimum, address recipient)",
  "function refundETH()",
  "function selfPermit(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
]);

let rpc: ReturnType<typeof fakeRpc>;
let uni: FakeUniswap;
let session: string;
let receiptLogs: unknown[] = [];

function startRpc(extra: Parameters<typeof fakeRpc>[0] = {}) {
  rpc = fakeRpc({
    eth_call: uniswapCall(uni),
    eth_getTransactionReceipt: (params) => ({ ...rpc.receipt("0x1", params[0] as string), logs: receiptLogs }),
    ...extra,
  });
}

beforeEach(async () => {
  resetDatabase();
  getDb().prepare("UPDATE settings SET value = '50' WHERE key = 'swap_slippage_bps'").run();
  lockWallet();
  rmSync(process.env.WALLET_KEYSTORE_PATH!, { force: true });
  uni = { extraPpm: 0, quotes: 0 };
  receiptLogs = [];
  startRpc();
  session = newSession();
  await setupWallet();
});
afterEach(() => setTransportFactoryForTests(null));

/** The router calls inside every swap transaction sent. */
function sentSwaps() {
  return rpc.calls
    .filter((c) => c.method === "eth_sendRawTransaction")
    .map((c) => parseTransaction(c.params[0] as Hex))
    .filter((tx) => tx.to?.toLowerCase() === UNI.router.toLowerCase())
    .map((tx) => {
      const outer = decodeFunctionData({ abi: router, data: tx.data! });
      const inner = (outer.args[1] as Hex[]).map((data) => decodeFunctionData({ abi: router, data }));
      return { value: tx.value ?? BigInt(0), deadline: outer.args[0] as bigint, calls: inner };
    });
}

const swapRows = () =>
  getDb().prepare("SELECT status, amount, swap_side AS side, swap_min_out AS minOut, swap_amount_out AS amountOut, swap_fee_tier AS fee FROM actions WHERE kind = 'swap' ORDER BY id").all() as {
    status: string; amount: string; side: string; minOut: string; amountOut: string | null; fee: number;
  }[];

const ethToUsdc = (extra = "") => `return [{ action: "swap", tokenIn: "ETH", tokenOut: "USDC", amountIn: parseEther("0.01")${extra} }];`;
const QUOTE_OUT = BigInt(499_750_000); // 0.01 ETH at 50,000 less the 0.05% fee
const MIN_OUT = (QUOTE_OUT * BigInt(9950)) / BigInt(10_000); // 0.5% slippage

describe("swap: ETH for USDC, exact input", () => {
  it("quotes every fee tier, takes the best, and shows the limit on the card", async () => {
    const w = watch(session, () => "rejected");
    await runPlan({ sessionId: session, decoded: decoded(ethToUsdc()), mode: "sign" });
    expect(uni.quotes).toBe(4);
    const [card] = w.approvals();
    const step = card.steps[0];
    expect(step).toMatchObject({ kind: "swap", symbolIn: "ETH", symbolOut: "USDC", side: "exact_in", feeTier: 500, slippageBps: 50, slippageSource: "settings" });
    expect(step.kind === "swap" && BigInt(step.amountOut)).toBe(QUOTE_OUT);
    expect(step.kind === "swap" && BigInt(step.minOut)).toBe(MIN_OUT);
    expect(step.kind === "swap" && step.priceImpactBps).toBe(0);
    expect(rpc.count("eth_sendRawTransaction")).toBe(0);
  });

  it("sends one router call: the exact ETH in, the minimum out, the user as recipient", async () => {
    receiptLogs = [usdcTransferLog(OWN, BigInt(499_700_000))];
    const w = watch(session);
    expect(await runPlan({ sessionId: session, decoded: decoded(ethToUsdc()), mode: "sign" })).toBe("completed");
    const [swap] = sentSwaps();
    expect(swap.value).toBe(BigInt(10) ** BigInt(16));
    expect(swap.calls.map((c) => c.functionName)).toEqual(["exactInputSingle"]);
    expect(swap.calls[0].args[0]).toMatchObject({ tokenIn: UNI.weth, tokenOut: UNI.usdc, fee: 500, recipient: OWN, amountIn: BigInt(10) ** BigInt(16), amountOutMinimum: MIN_OUT });
    expect(Number(swap.deadline)).toBeGreaterThan(Date.now() / 1000);
    expect(swapRows()).toEqual([{ status: "confirmed", amount: "10000000000000000", side: "exact_in", minOut: MIN_OUT.toString(), amountOut: "499700000", fee: 500 }]);
    expect(w.steps().at(-1)?.steps[0].detail).toBe("Received 499.7 USDC.");
  });

  it("is never approved automatically, even within saved limits", async () => {
    userTyped(session, "swap");
    setLimit("ETH", BigInt(10) ** BigInt(18), BigInt(10) ** BigInt(19), BigInt(10) ** BigInt(20));
    const w = watch(session, () => "rejected");
    await runPlan({ sessionId: session, decoded: decoded(ethToUsdc()), mode: "sign" });
    expect(w.approvals()).toHaveLength(1);
  });

  it("explains without estimating or sending", async () => {
    const w = watch(session);
    await runPlan({ sessionId: session, decoded: decoded(ethToUsdc()), mode: "explain" });
    expect(w.steps()[0].steps[0].text).toBe("Swap 0.01 ETH for at least 497.25125 USDC on Uniswap (Sepolia).");
    expect(rpc.count("eth_sendRawTransaction")).toBe(0);
  });
});

describe("swap: USDC for ETH (token in)", () => {
  it("lets the router take exactly the amount with a permit inside the same transaction, and unwraps to ETH", async () => {
    receiptLogs = [wethWithdrawalLog(BigInt(199_000_000_000_000))];
    watch(session);
    const code = `return [{ action: "swap", tokenIn: "USDC", tokenOut: "ETH", amountIn: parseUnits("10", "USDC") }];`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("completed");
    const [swap] = sentSwaps();
    expect(swap.value).toBe(BigInt(0));
    expect(swap.calls.map((c) => c.functionName)).toEqual(["selfPermit", "exactInputSingle", "unwrapWETH9"]);
    expect(swap.calls[0].args.slice(0, 3)).toEqual([UNI.usdc, BigInt(10_000_000), swap.deadline]);
    const exact = swap.calls[1].args[0] as { recipient: string; amountOutMinimum: bigint };
    expect(exact.recipient).toBe("0x0000000000000000000000000000000000000002"); // the router, which unwraps
    const quote = BigInt(199_900_000_000_000); // 10 USDC at 50,000 less 0.05%
    const min = (quote * BigInt(9950)) / BigInt(10_000);
    expect(exact.amountOutMinimum).toBe(min);
    expect(swap.calls[2].args).toEqual([min, OWN]);
    expect(swapRows()[0]).toMatchObject({ status: "confirmed", amountOut: "199000000000000" });
  });
});

describe("swap: exact output", () => {
  it("pays at most the quote plus slippage, and returns the unused ETH", async () => {
    watch(session);
    const code = `return [{ action: "swap", tokenIn: "ETH", tokenOut: "USDC", amountOut: parseUnits("100", "USDC") }];`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("completed");
    const [swap] = sentSwaps();
    const call = swap.calls[0].args[0] as { amountOut: bigint; amountInMaximum: bigint; recipient: string };
    expect(swap.calls.map((c) => c.functionName)).toEqual(["exactOutputSingle", "refundETH"]);
    expect(call.amountOut).toBe(BigInt(100_000_000));
    expect(call.recipient).toBe(OWN);
    expect(swap.value).toBe(call.amountInMaximum);
    const row = swapRows()[0];
    expect(row).toMatchObject({ side: "exact_out", minOut: "100000000" });
    expect(BigInt(row.amount)).toBe(call.amountInMaximum);
  });
});

describe("slippage", () => {
  const typed = "swap 0.01 ETH to USDC with 2% slippage";

  it("asks 'are you sure' before the card when the user typed more than the setting, and uses it once confirmed", async () => {
    userTyped(session, typed);
    const w = watch(session);
    expect(await runPlan({ sessionId: session, decoded: decoded(ethToUsdc(`, slippage: "2"`)), mode: "sign", userTyped: [typed] })).toBe("completed");
    const kinds = w.events.filter((e) => e.type === "approval_request").map((e) => (e as { request: { kind: string } }).request.kind);
    expect(kinds).toEqual(["slippage_confirm", "plan"]);
    const confirm = w.events.find((e) => e.type === "approval_request" && (e as { request: { kind: string } }).request.kind === "slippage_confirm") as unknown as {
      request: { swaps: { requestedBps: number; settingsBps: number; effect: string }[] };
    };
    expect(confirm.request.swaps[0]).toMatchObject({ requestedBps: 200, settingsBps: 50 });
    expect(confirm.request.swaps[0].effect).toBe("You could receive as little as 489.755 USDC (quote 499.75).");
    expect((sentSwaps()[0].calls[0].args[0] as { amountOutMinimum: bigint }).amountOutMinimum).toBe(BigInt(489_755_000));
  });

  it("cancels everything when the higher slippage is not confirmed", async () => {
    const w = watch(session, (request) => (request.kind === "slippage_confirm" ? "rejected" : "approved"));
    expect(await runPlan({ sessionId: session, decoded: decoded(ethToUsdc(`, slippage: "2"`)), mode: "sign", userTyped: [typed] })).toBe("cancelled");
    expect(w.approvals().filter((a) => a.kind === "plan")).toHaveLength(0);
    expect(rpc.count("eth_sendRawTransaction")).toBe(0);
    expect(swapRows()[0].status).toBe("rejected");
  });

  it("needs no extra confirmation for a typed slippage at or below the setting", async () => {
    getDb().prepare("UPDATE settings SET value = '300' WHERE key = 'swap_slippage_bps'").run();
    const w = watch(session);
    await runPlan({ sessionId: session, decoded: decoded(ethToUsdc(`, slippage: "2"`)), mode: "sign", userTyped: [typed] });
    expect(w.approvals().map((a) => a.kind)).toEqual(["plan"]);
    expect(w.approvals()[0].steps[0]).toMatchObject({ slippageBps: 200, slippageSource: "user" });
  });

  it("ignores a slippage the user did not type (from the model, a document or pasted text) and uses the setting", async () => {
    const w = watch(session, () => "rejected");
    await runPlan({ sessionId: session, decoded: decoded(ethToUsdc(`, slippage: "50"`)), mode: "sign", userTyped: ["swap 0.01 ETH to USDC"] });
    const [card] = w.approvals();
    expect(card.kind).toBe("plan");
    expect(card.steps[0]).toMatchObject({ slippageBps: 50, slippageSource: "settings" });
    expect(card.warnings.map((x) => x.message).join(" ")).toMatch(/asked for 50% slippage, which you did not type in this request, so your setting of 0.5% is used/);
  });
});

describe("price impact", () => {
  it("warns above 2%", async () => {
    uni.extraPpm = 50_000;
    const w = watch(session, () => "rejected");
    await runPlan({ sessionId: session, decoded: decoded(ethToUsdc()), mode: "sign" });
    expect(w.approvals()[0].warnings.map((x) => x.message).join(" ")).toMatch(/moves the pool's price 5% against you/);
  });

  it("blocks above 10%", async () => {
    uni.extraPpm = 150_000;
    const w = watch(session);
    expect(await runPlan({ sessionId: session, decoded: decoded(ethToUsdc()), mode: "sign" })).toBe("failed");
    expect(w.approvals()).toHaveLength(0);
    expect(w.steps()[0].steps[0].detail).toMatch(/price impact would be 15%, above the 10% limit/);
    expect(rpc.count("eth_sendRawTransaction")).toBe(0);
  });

  it("is measured against the pool's own price, after its fee", () => {
    const sqrt = BigInt("79228162514264337593543950336"); // price 1 (2^96)
    expect(priceImpactBps(BigInt(1_000_000), BigInt(999_500), sqrt, true, 500)).toBe(0);
    expect(priceImpactBps(BigInt(1_000_000), BigInt(949_525), sqrt, true, 500)).toBe(500);
  });
});

describe("re-quote before sending", () => {
  it("sends nothing if the price got worse than the approved minimum", async () => {
    const w = watch(session, () => {
      uni.extraPpm = 10_000; // the price moves 1% after the card was shown
      return "approved";
    });
    expect(await runPlan({ sessionId: session, decoded: decoded(ethToUsdc()), mode: "sign" })).toBe("failed");
    expect(rpc.count("eth_sendRawTransaction")).toBe(0);
    expect(w.steps().at(-1)?.steps[0].detail).toMatch(/The price moved: this swap would now return 494\.7525 USDC, below the 497\.25125 you approved\. Nothing was sent/);
    expect(swapRows()[0].status).toBe("failed");
  });
});

describe("swap, then send what it buys", () => {
  it("counts only the swap's minimum for the transfer, and sends the transfer only after the swap is confirmed", async () => {
    let swapped = false;
    startRpc({
      // Before the swap the node cannot estimate a USDC transfer of more than the wallet holds.
      eth_estimateGas: (params) => {
        const tx = params[0] as { to?: string };
        if (tx.to?.toLowerCase() === UNI.usdc.toLowerCase() && !swapped) throw Object.assign(new Error("execution reverted: ERC20: transfer amount exceeds balance"), { code: 3 });
        return "0x5208";
      },
      eth_sendRawTransaction: (_params, n) => {
        swapped = true;
        return `0x${n.toString(16).padStart(64, "0")}`;
      },
    });
    userTyped(session, ALICE);
    const w = watch(session);
    const code = `return [
      { action: "swap", tokenIn: "ETH", tokenOut: "USDC", amountIn: parseEther("0.01") },
      { action: "transfer", to: "${ALICE}", token: "USDC", amount: parseUnits("400", "USDC") },
    ];`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("completed");
    const [card] = w.approvals();
    expect(card.steps.map((s) => s.runnable)).toEqual([true, true]); // 25 held + at least 497.25 bought >= 400
    const order = rpc.calls.map((c) => c.method).filter((m) => m === "eth_sendRawTransaction" || m === "eth_getTransactionReceipt");
    expect(order.slice(0, 3)).toEqual(["eth_sendRawTransaction", "eth_getTransactionReceipt", "eth_sendRawTransaction"]);
  });

  it("does not let a later step spend more than the swap's guaranteed minimum", async () => {
    userTyped(session, ALICE);
    const w = watch(session, () => "rejected");
    const code = `return [
      { action: "swap", tokenIn: "ETH", tokenOut: "USDC", amountIn: parseEther("0.01") },
      { action: "transfer", to: "${ALICE}", token: "USDC", amount: parseUnits("523", "USDC") },
    ];`;
    await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" });
    const [card] = w.approvals();
    expect(card.steps[1].runnable).toBe(false);
    expect(card.steps[1].note).toMatch(/Not enough USDC/);
  });
});

describe("no route", () => {
  it("reports a pair with no pool before anything is asked", async () => {
    const w = watch(session);
    const code = `return [{ action: "swap", tokenIn: "EURC", tokenOut: "USDC", amountIn: parseUnits("5", "EURC") }];`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("failed");
    expect(w.steps()[0].steps[0].detail).toMatch(/No Uniswap pool on this network can quote this swap/);
  });

  it("refuses a malformed swap", async () => {
    const w = watch(session);
    const code = `return [{ action: "swap", tokenIn: "ETH", tokenOut: "USDC", amountIn: 1n, amountOut: 1n }];`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("failed");
    expect(w.statuses().join(" ")).toMatch(/needs exactly one of amountIn .* or amountOut/);
  });

  it("refuses a recipient: the wallet always keeps what it buys", async () => {
    const w = watch(session);
    const code = `return [{ action: "swap", tokenIn: "ETH", tokenOut: "USDC", amountIn: 1n, recipient: "${ALICE}" }];`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("failed");
    expect(w.statuses().join(" ")).toMatch(/unknown fields: recipient/);
  });
});

describe("quotes for programs", () => {
  it("wallet.quoteSwap returns the best quote, and the dry run and real run share it", async () => {
    const w = watch(session);
    const code = `const q = await wallet.quoteSwap({ tokenIn: "ETH", tokenOut: "USDC", amountIn: parseEther("1") });
ui.show({ text: formatUnits(q.amountOut, "USDC") });`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("completed");
    expect(w.outputs()).toEqual([{ type: "output", content: { type: "text", text: "49975" } }]);
  });
});

describe("feasibility rule for swaps", () => {
  it("debits the most paid and credits only the least received", () => {
    const r = assessSteps(
      [
        { index: 0, kind: "swap", token: "ETH", decimals: 18, amount: BigInt(10) ** BigInt(16), feeWei: BigInt(0), tokenOut: "USDC", minOut: BigInt(497_000_000) },
        { index: 1, kind: "transfer", token: "USDC", decimals: 6, amount: BigInt(500_000_000) },
      ],
      new Set(),
      { ETH: BigInt(10) ** BigInt(18), USDC: BigInt(5_000_000) },
    );
    expect(r.verdicts.map((v) => v.state)).toEqual(["runnable", "runnable"]);
    expect(r.balancesAfter.USDC).toBe(BigInt(2_000_000));
  });
});

describe("database not upgraded yet", () => {
  it("says to restart the app instead of 'something went wrong'", async () => {
    const db = getDb();
    db.exec("ALTER TABLE dex_contracts RENAME TO dex_contracts_hidden");
    try {
      const w = watch(session);
      const code = `const q = await wallet.quoteSwap({ tokenIn: "ETH", tokenOut: "USDC", amountIn: parseEther("1") });`;
      expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("failed");
      expect(w.statuses().join(" ")).toMatch(/Swaps are not set up in the database yet\. Restart the app/);
    } finally {
      db.exec("ALTER TABLE dex_contracts_hidden RENAME TO dex_contracts");
    }
  });
});
