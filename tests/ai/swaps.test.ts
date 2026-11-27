import { describe, expect, it } from "vitest";
import { loadManifest } from "@/ai/manifest";
import { planningMessages } from "@/ai/prompts";
import { checkCode } from "@/ai/verifier/ast-checks";
import { describeDryRun, dryRun } from "@/ai/verifier/dry-run";

// Swaps in the AI layer: the verifier accepts swap programs, the dry run
// quotes with sample prices and describes swaps for the reviewer.

const check = (code: string) => checkCode(code, { manifest: loadManifest(), isKnownPlaceholder: () => true });

describe("swap programs", () => {
  it("are accepted by the verifier, with wallet.quoteSwap", () => {
    const result = check(`const q = await wallet.quoteSwap({ tokenIn: "ETH", tokenOut: "USDC", amountIn: parseEther("0.5") });
await propose([{ action: "swap", tokenIn: "ETH", tokenOut: "USDC", amountIn: parseEther("0.5"), slippage: "1" }]);`);
    expect(result.errors).toEqual([]);
    expect(result.functionsCalled).toEqual(expect.arrayContaining(["wallet.quoteSwap", "propose"]));
  });

  it("run in the dry run with sample quotes, and are described for the reviewer", async () => {
    const run = await dryRun(`const q = await wallet.quoteSwap({ tokenIn: "ETH", tokenOut: "USDC", amountIn: parseEther("0.5") });
ui.show({ text: formatUnits(q.amountOut, "USDC") });
await propose([{ action: "swap", tokenIn: "ETH", tokenOut: "USDC", amountOut: parseUnits("100", "USDC"), slippage: "2" }]);`);
    expect(run.error).toBeNull();
    expect(run.shown).toEqual([{ text: "1000" }]);
    const report = describeDryRun(run);
    expect(report).toContain("swap ETH for exactly 100 USDC, slippage 2%");
    expect(report).toContain("wallet.quoteSwap: 1 ETH = 2,000 USDC = 2,000 EURC");
  });

  it("are no longer rejected by the planner as unsupported", () => {
    const system = planningMessages(loadManifest(), [{ role: "user", text: "swap 0.1 ETH to USDC" }])[0].content;
    expect(system).toContain("Swapping one token for another (ETH, USDC, EURC) on Uniswap is supported");
    expect(system).not.toMatch(/for example token prices, swaps/);
  });
});

describe("percentages are not units", () => {
  it("does not refuse '10%' as an unsupported unit, but still refuses USDT", async () => {
    const { runAiLayer } = await import("@/ai");
    const { NO_ERRORS, coderReply, completePlan, makeDeps, newSessionId, scriptedModel } = await import("./helpers/fixtures");
    const code = `const q = await wallet.quoteSwap({ tokenIn: "USDC", tokenOut: "EURC", amountIn: parseUnits("10", "USDC") });\nui.show({ text: String(q.priceImpact) });`;
    const ok = scriptedModel({
      planning: [completePlan({ units: ["USDC", "EURC", "10%"] })],
      coding: [coderReply(code, ["wallet.quoteSwap", "parseUnits", "ui.show"])],
      review: [NO_ERRORS],
    });
    const deps = makeDeps(ok);
    const prompt = "Spending how much USDC for EURC keeps price impact below 10%?";
    expect((await runAiLayer(deps, newSessionId(), deps.encoder.encode(prompt, { kind: "user" }))).result.type).toBe("code");

    const refused = scriptedModel({ planning: [completePlan({ units: ["USDT", "2 percent"] })] });
    const deps2 = makeDeps(refused);
    const run = await runAiLayer(deps2, newSessionId(), deps2.encoder.encode("swap 5 USDT with 2 percent slippage", { kind: "user" }));
    expect(run.result).toMatchObject({ type: "rejection", reason: "unsupported_unit" });
    expect(run.result.type === "rejection" && run.result.message).toMatch(/^USDT is not supported/);
  });

  it("the 'largest amount within the limit' example runs in the dry run", async () => {
    const run = await dryRun(`const balance = await wallet.getBalance({ token: "USDC" });
const ladder = ["1", "2", "5", "10", "20", "50", "100", "200"].map((a) => parseUnits(a, "USDC")).filter((a) => a <= balance);
let best = null;
for (const amountIn of ladder) {
  try {
    const quote = await wallet.quoteSwap({ tokenIn: "USDC", tokenOut: "EURC", amountIn });
    if (quote.priceImpact <= 10) best = quote;
  } catch (error) {}
}
ui.show({ text: best === null ? "none" : formatUnits(best.amountIn, "USDC") });`);
    expect(run.error).toBeNull();
    expect(run.shown).toEqual([{ text: "100" }]); // sample balance is 100 USDC
  });
});
