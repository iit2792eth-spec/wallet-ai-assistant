import { describe, expect, it } from "vitest";
import { MaskVault } from "@/text-encoder";
import { checkCode } from "@/ai/verifier/ast-checks";
import { ADDRESS_A, ADDRESS_B, manifest } from "./helpers/fixtures";
import { runInStubSandbox } from "./helpers/stub-runner";

// The two programs from section 4.3 pass verification and behave as intended
// when run in QuickJS against fake wallet functions.

const encoder = new MaskVault();
const verify = (code: string) =>
  checkCode(code, { manifest, isKnownPlaceholder: (placeholder) => encoder.isKnownPlaceholder(placeholder) }).errors;

const history = [
  { to: ADDRESS_A, token: "ETH", amount: BigInt(5) },
  { to: ADDRESS_B, token: "USDC", amount: BigInt(7) },
  { to: ADDRESS_A, token: "ETH", amount: BigInt(1) },
];

describe("specification examples", () => {
  it("example 1: sends double the amounts of the latest transfers", async () => {
    const code = `const txs = await wallet.getHistory({ limit: 5, direction: "sent" });
return txs.map(tx => ({ action: "transfer", to: tx.to, token: tx.token, amount: tx.amount * 2n }));`;
    expect(verify(code)).toEqual([]);

    const run = await runInStubSandbox(code, { history });
    expect(run.error).toBeNull();
    expect(run.proposals).toEqual([
      [
        { action: "transfer", to: ADDRESS_A, token: "ETH", amount: BigInt(10) },
        { action: "transfer", to: ADDRESS_B, token: "USDC", amount: BigInt(14) },
        { action: "transfer", to: ADDRESS_A, token: "ETH", amount: BigInt(2) },
      ],
    ]);
  });

  it("example 2: shows the recipients, then proposes a transfer to each", async () => {
    const code = `const txs = await wallet.getHistory({ direction: "sent" });
const recipients = unique(txs.map(t => t.to)).slice(0, 5);
ui.show({ title: "Your 5 latest recipients", list: recipients });
const result = await propose(recipients.map(to => ({
  action: "transfer", to, token: "ETH", amount: parseEther("10")
})));
ui.show({ text: result.approved ? "Done." : "Cancelled." });`;
    expect(verify(code)).toEqual([]);

    const run = await runInStubSandbox(code, { history, approve: false });
    expect(run.error).toBeNull();
    expect(run.shown).toEqual([
      { title: "Your 5 latest recipients", list: [ADDRESS_A, ADDRESS_B] },
      { text: "Cancelled." },
    ]);
    expect(run.proposals).toEqual([
      [
        { action: "transfer", to: ADDRESS_A, token: "ETH", amount: BigInt("10000000000000000000") },
        { action: "transfer", to: ADDRESS_B, token: "ETH", amount: BigInt("10000000000000000000") },
      ],
    ]);
  });

  it("a dependent request: sends half of the balance", async () => {
    const code = `const balance = await wallet.getBalance({ token: "ETH" });
ui.show({ title: "ETH balance", text: formatUnits(balance, "ETH") });
return [{ action: "transfer", to: "anuneet.eth", token: "ETH", amount: balance / 2n }];`;
    const run = await runInStubSandbox(code, { balances: { ETH: BigInt("3000000000000000000") } });
    expect(run.error).toBeNull();
    expect(run.shown).toEqual([{ title: "ETH balance", text: "3" }]);
    expect(run.proposals).toEqual([[{ action: "transfer", to: "anuneet.eth", token: "ETH", amount: BigInt("1500000000000000000") }]]);
  });
});
