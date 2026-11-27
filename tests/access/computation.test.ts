import { rmSync } from "node:fs";
import { parseTransaction, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPlan } from "@/access";
import { setTransportFactoryForTests } from "@/wallet/clients";
import { lockWallet } from "@/wallet";
import { fakeRpc } from "../helpers/fake-rpc";
import { ALICE, BOB, ETH, decoded, fromWebPage, newSession, pastTransfer, resetDatabase, setupWallet, userTyped, watch } from "./helpers";

// General computation over function results, run through the real sandbox.

let session: string;
let rpc: ReturnType<typeof fakeRpc>;
beforeEach(async () => {
  resetDatabase();
  lockWallet();
  rmSync(process.env.WALLET_KEYSTORE_PATH!, { force: true });
  rpc = fakeRpc();
  session = newSession();
  await setupWallet();
});
afterEach(() => setTransportFactoryForTests(null));

describe("computation", () => {
  it("adds up today's spending per token, ignoring older transfers", async () => {
    pastTransfer(ALICE, "ETH", ETH("0.1"), { secondsAgo: 60 });
    pastTransfer(BOB, "ETH", ETH("0.25"), { secondsAgo: 120 });
    pastTransfer(BOB, "USDC", BigInt(7_500_000), { secondsAgo: 180 });
    pastTransfer(ALICE, "ETH", ETH("9"), { secondsAgo: 3 * 86400 });
    const w = watch(session);
    const code = `const today = new Date(now() * 1000);
today.setHours(0, 0, 0, 0);
const since = Math.floor(today.getTime() / 1000);
const history = await wallet.getHistory({ limit: 50 });
const totals = new Map();
for (const tx of history.filter((t) => t.timestamp >= since)) {
  totals.set(tx.token, (totals.get(tx.token) ?? 0n) + tx.amount);
}
const lines = ["ETH", "USDC"].map((token) => \`\${token}: \${formatUnits(totals.get(token) ?? 0n, token)}\`);
ui.show({ title: "Sent today", list: lines });`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("completed");
    expect(w.outputs()).toEqual([{ type: "output", content: { type: "list", title: "Sent today", items: ["ETH: 0.35", "USDC: 7.5"] } }]);
  });

  it("sorts, ranks and averages", async () => {
    pastTransfer(ALICE, "ETH", ETH("0.3"));
    pastTransfer(BOB, "ETH", ETH("0.1"));
    pastTransfer(ALICE, "ETH", ETH("0.2"));
    const w = watch(session);
    const code = `const history = await wallet.getHistory({ limit: 50 });
const byRecipient = new Map();
for (const tx of history) byRecipient.set(tx.to, (byRecipient.get(tx.to) ?? 0n) + tx.amount);
const ranked = [...byRecipient.entries()].sort((a, b) => (b.at(1) > a.at(1) ? 1 : -1));
const total = history.reduce((sum, tx) => sum + tx.amount, 0n);
const average = total / BigInt(history.length);
ui.show({ title: "Top recipient", text: \`\${ranked.at(0).at(0)} received \${formatUnits(ranked.at(0).at(1), "ETH")} ETH; average transfer \${formatUnits(average, "ETH")} ETH\` });`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("completed");
    expect(w.outputs()).toEqual([
      { type: "output", content: { type: "text", text: `Top recipient\n${ALICE} received 0.5 ETH; average transfer 0.2 ETH` } },
    ]);
  });

  it("sends all ETH minus the fee, and the transaction can never cost more than that fee", async () => {
    userTyped(session, ALICE);
    const w = watch(session);
    const code = `const balance = await wallet.getBalance({ token: "ETH" });
const fee = await wallet.estimateFee({ token: "ETH", to: "${ALICE}" });
const amount = balance - fee;
ui.show({ title: "Send all ETH", text: formatUnits(amount, "ETH"), list: ["${ALICE}"] });
await propose([{ action: "transfer", to: "${ALICE}", token: "ETH", amount }]);`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("completed");
    const [approval] = w.approvals();
    expect(approval.runnableCount).toBe(1);
    expect(approval.warnings).toEqual([]);
    expect(w.statuses()).not.toContain("The plan changed after it was checked, so the next step needs approval again.");
    const [tx] = rpc.calls.filter((c) => c.method === "eth_sendRawTransaction").map((c) => parseTransaction(c.params[0] as Hex));
    // value + gas * maxFeePerGas is exactly the 5 ETH balance: the worst-case fee fits.
    expect(tx.value! + tx.gas! * tx.maxFeePerGas!).toBe(ETH("5"));
    expect(rpc.count("eth_estimateGas")).toBe(1);
  });

  it("pays a fixed amount and then all remaining ETH, both affordable to the last wei", async () => {
    fromWebPage(session, ALICE, BOB);
    const w = watch(session);
    const code = `const balance = await wallet.getBalance({ token: "ETH" });
const fee1 = await wallet.estimateFee({ token: "ETH", to: "${ALICE}" });
const fee2 = await wallet.estimateFee({ token: "ETH", to: "${BOB}" });
const first = parseEther("0.05");
const rest = balance - first - fee1 - fee2;
await propose([{ action: "transfer", to: "${ALICE}", token: "ETH", amount: first }, { action: "transfer", to: "${BOB}", token: "ETH", amount: rest }]);`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign", external: true })).toBe("completed");
    expect(w.approvals()[0].runnableCount).toBe(2);
    const sent = rpc.calls.filter((c) => c.method === "eth_sendRawTransaction").map((c) => parseTransaction(c.params[0] as Hex));
    expect(sent).toHaveLength(2);
    // Both amounts plus both worst-case fees use up exactly the 5 ETH balance.
    expect(sent.reduce((sum, tx) => sum + tx.value! + tx.gas! * tx.maxFeePerGas!, BigInt(0))).toBe(ETH("5"));
  });

  it("shows instead of proposing when the balance does not cover the fee", async () => {
    rpc = fakeRpc({ eth_getBalance: () => "0x1" });
    userTyped(session, ALICE);
    const w = watch(session);
    const code = `const balance = await wallet.getBalance({ token: "ETH" });
const fee = await wallet.estimateFee({ token: "ETH", to: "${ALICE}" });
if (balance <= fee) {
  ui.show({ text: "Not enough ETH to cover the network fee." });
} else {
  await propose([{ action: "transfer", to: "${ALICE}", token: "ETH", amount: balance - fee }]);
}`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("completed");
    expect(w.approvals()).toHaveLength(0);
    expect(w.outputs()).toEqual([{ type: "output", content: { type: "text", text: "Not enough ETH to cover the network fee." } }]);
  });

  it("gives the dry run and the real run the same now()", async () => {
    // If now() differed between runs, an amount computed from it would change and need re-approval.
    const w = watch(session);
    const code = `const t = now();
return [{ action: "transfer", to: "${ALICE}", token: "ETH", amount: BigInt(t % 1000) + 1n }];`;
    await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" });
    expect(w.approvals()).toHaveLength(1);
    expect(w.statuses()).not.toContain("The plan changed after it was checked, so the next step needs approval again.");
  });
});
