import { rmSync } from "node:fs";
import { verifyTypedData } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPlan } from "@/access";
import { setTransportFactoryForTests } from "@/wallet/clients";
import { lockWallet } from "@/wallet";
import { fakeRpc } from "../helpers/fake-rpc";
import { ALICE, OWN, decoded, fromWebPage, newSession, resetDatabase, setLimit, setupWallet, userTyped, watch } from "./helpers";

// Signatures described in words (the permit template) and pasted typed data.

let session: string;
beforeEach(async () => {
  resetDatabase();
  lockWallet();
  rmSync(process.env.WALLET_KEYSTORE_PATH!, { force: true });
  fakeRpc();
  session = newSession();
  await setupWallet();
});
afterEach(() => setTransportFactoryForTests(null));

const permitCode = (spender: string, params = "") =>
  `await propose([{ action: "sign_typed_data", template: "permit", params: { token: "USDC", spender: "${spender}", amount: parseUnits("25", "USDC")${params} } }]);`;

describe("permit described in words", () => {
  it("builds the permit from the chain, asks, and produces a valid signature", async () => {
    userTyped(session, ALICE);
    setLimit("USDC", BigInt(10) ** BigInt(12), BigInt(10) ** BigInt(12), BigInt(10) ** BigInt(12));
    const w = watch(session);
    expect(await runPlan({ sessionId: session, decoded: decoded(permitCode(ALICE, ", deadline: now() + 7 * 24 * 60 * 60")), mode: "sign" })).toBe("completed");

    const [approval] = w.approvals();
    const step = approval.steps[0];
    if (step.kind !== "typed_data") throw new Error("expected a typed-data step");
    expect(step.knownType).toBe("Permit (EIP-2612)");
    expect(step.summary).toMatch(/^Lets 0x7099…79C8 spend 25 USDC of your tokens, until /);
    // Domain and nonce come from the token contract and the wallet, not from the program.
    expect(step.domain).toEqual({ name: "USDC", version: "2", chainId: 11155111, verifyingContract: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" });
    expect(step.message).toMatchObject({ owner: OWN, spender: ALICE, value: "25000000", nonce: "3" });

    const signature = w.steps().at(-1)!.steps[0].detail!.replace("Signature: ", "") as `0x${string}`;
    const valid = await verifyTypedData({
      domain: step.domain as never,
      types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Permit",
      message: step.message as never,
      address: OWN,
      signature,
    });
    expect(valid).toBe(true);
  });

  it("defaults the deadline to one hour", async () => {
    userTyped(session, ALICE);
    const w = watch(session);
    await runPlan({ sessionId: session, decoded: decoded(permitCode(ALICE)), mode: "sign" });
    const step = w.approvals()[0].steps[0];
    const deadline = Number(step.kind === "typed_data" && step.message.deadline);
    expect(Math.abs(deadline - (Math.floor(Date.now() / 1000) + 3600))).toBeLessThan(60);
  });

  it("warns when the spender came from a web page", async () => {
    fromWebPage(session, ALICE);
    const w = watch(session);
    await runPlan({ sessionId: session, decoded: decoded(permitCode(ALICE)), mode: "sign" });
    expect(w.approvals()[0].warnings.map((x) => x.message).join(" ")).toMatch(/came from a web page/);
  });

  it("refuses a deadline in the past", async () => {
    userTyped(session, ALICE);
    const w = watch(session);
    await runPlan({ sessionId: session, decoded: decoded(permitCode(ALICE, ", deadline: 1000")), mode: "sign" });
    expect(w.steps()[0].steps[0].detail).toBe("The permit's deadline has already passed.");
  });

  it("explains a permit without signing", async () => {
    userTyped(session, ALICE);
    const w = watch(session);
    await runPlan({ sessionId: session, decoded: decoded(permitCode(ALICE)), mode: "explain" });
    expect(w.steps()[0].title).toBe("What this would do");
    expect(w.steps()[0].steps[0].text).toMatch(/Sign a Permit \(EIP-2612\) message for USDC\. Lets 0x7099…79C8 spend 25 USDC/);
    expect(w.approvals()).toHaveLength(0);
  });

  it("blocks a permit for ETH, which is not a token contract", async () => {
    const w = watch(session);
    const code = `await propose([{ action: "sign_typed_data", template: "permit", params: { token: "ETH", spender: "${ALICE}", amount: 1n } }]);`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("failed");
    expect(w.statuses().join(" ")).toMatch(/ETH is not a token contract/);
  });
});

describe("pasted typed data", () => {
  it("signs typed data written in the program, with restored addresses inside", async () => {
    const w = watch(session);
    const code = `const typedData = {
  domain: { name: "Example", version: "1", chainId: 11155111, verifyingContract: "${ALICE}" },
  types: { Mail: [{ name: "from", type: "address" }, { name: "contents", type: "string" }] },
  primaryType: "Mail",
  message: { from: "${OWN}", contents: "Hello" },
};
await propose([{ action: "sign_typed_data", typedData }]);`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("completed");
    expect(w.approvals()[0].warnings.map((x) => x.message).join(" ")).toMatch(/Unknown message type/);
    expect(w.steps().at(-1)!.steps[0].detail).toMatch(/^Signature: 0x[0-9a-f]{130}$/);
  });
});
