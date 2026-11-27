import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPlan } from "@/access";
import { LIMITS } from "@/access/config";
import { runSandbox, type SandboxHost } from "@/access/sandbox";
import { setTransportFactoryForTests } from "@/wallet/clients";
import { lockWallet } from "@/wallet";
import { fakeRpc } from "../helpers/fake-rpc";
import { ALICE, actionRows, decoded, newSession, resetDatabase, setupWallet, userTyped, watch } from "./helpers";

// Attacks on the sandbox. Most are already refused by the plan validator, so
// the sandbox's own limits are also tested directly, as if the validator had a gap.

const noHost: SandboxHost = { call: async () => null, show: () => {} };
const run = (code: string, host: SandboxHost = noHost) => runSandbox(code, host, new AbortController().signal);

describe("sandbox limits, tested directly", () => {
  it("stops an infinite loop on CPU time", async () => {
    const started = Date.now();
    const result = await run("while (true) {}");
    expect(result).toMatchObject({ status: "failed", limit: true, reason: expect.stringMatching(/processing time/) });
    expect(Date.now() - started).toBeLessThan(LIMITS.cpuMs + 3000);
  });

  it("stops a memory bomb", async () => {
    const result = await run('let s = "x"; for (;;) s += s;');
    expect(result).toMatchObject({ status: "failed", limit: true });
    expect(result.status === "failed" && result.reason).toMatch(/memory|processing time/);
  });

  it("stops deep recursion", async () => {
    const result = await run("const f = (n) => f(n + 1) + 1; f(0);");
    expect(result).toMatchObject({ status: "failed", limit: true });
  });

  it("does not let the program change the host's prototypes", async () => {
    await run("Object.prototype.polluted = 1; Array.prototype.push = null;");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(typeof [].push).toBe("function");
  });

  it("gives the program no host globals", async () => {
    const shown: unknown[] = [];
    await run(
      'ui.show({ text: [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof __host, typeof globalThis.__show].join(",") });',
      { call: async () => null, show: (c) => shown.push(c) },
    );
    expect(shown).toEqual([{ text: "undefined,undefined,undefined,undefined,undefined,undefined" }]);
  });

  it("hands the host a frozen copy: later changes in the program do not reach it", async () => {
    let received: unknown;
    const host: SandboxHost = { call: async (_n, args) => ((received = args[0]), null), show: () => {} };
    await run('const a = [{ amount: 1n }]; const p = propose(a); a[0].amount = 999n; await p;', host);
    expect(received).toEqual([{ amount: BigInt(1) }]);
    expect(Object.isFrozen((received as object[])[0])).toBe(true);
  });

  it("cannot break out through the constructor chain", async () => {
    const result = await run('const F = (() => {}).constructor; const g = F("return this")(); ui.show({ text: typeof g.process });', {
      call: async () => null,
      show: (c) => expect(c).toEqual({ text: "undefined" }),
    });
    expect(result.status).toBe("completed");
  });
});

describe("attacks through runPlan", () => {
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

  it.each([
    ["an unbounded loop", "while (true) {}"],
    ["constructor access", "const F = [].constructor;"],
    ["globalThis", "const g = globalThis;"],
    ["eval", 'eval("1");'],
  ])("the validator refuses %s before it runs", async (_name, code) => {
    const w = watch(session);
    expect(await runPlan({ sessionId: session, decoded: decoded(code, []), mode: "sign" })).toBe("failed");
    expect(w.statuses()).toContain("The plan did not pass the safety checks, so nothing was run.");
  });

  it("stops a program that floods host calls", async () => {
    // Lowered for the test, so it does not need thousands of fake RPC round trips.
    const limits = LIMITS as { maxHostCalls: number };
    const saved = limits.maxHostCalls;
    limits.maxHostCalls = 200;
    try {
      const w = watch(session);
      const code = `for (const i of Array.from({ length: 300 })) { await wallet.getBalance({ token: "ETH" }); }`;
      expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("failed");
      expect(w.statuses().join(" ")).toMatch(/more than 200 calls/);
    } finally {
      limits.maxHostCalls = saved;
    }
  });

  it("refuses oversized ui.show content", async () => {
    const w = watch(session);
    const code = `ui.show({ text: "x".repeat(${LIMITS.maxTextChars + 1}) });`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("failed");
    expect(w.statuses().join(" ")).toMatch(/at most 2000 characters/);
    expect(w.outputs()).toEqual([]);
  });

  it("stops a program that proposes too many times", async () => {
    userTyped(session, ALICE);
    const w = watch(session);
    const code = `for (const i of Array.from({ length: 6 })) { await propose([{ action: "transfer", to: "${ALICE}", token: "ETH", amount: 1n }]); }`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("failed");
    expect(w.statuses().join(" ")).toMatch(/proposed actions more than 5 times/);
    expect(w.approvals()).toHaveLength(0);
    expect(actionRows()).toEqual([]);
  });

  it("refuses a runaway plan above the 1,000-action ceiling", async () => {
    userTyped(session, ALICE);
    const w = watch(session);
    const code = `return Array.from({ length: 1001 }).map(() => ({ action: "transfer", to: "${ALICE}", token: "ETH", amount: 1n }));`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("failed");
    expect(w.statuses().join(" ")).toMatch(/more than 1,000 actions/);
    expect(w.approvals()).toHaveLength(0);
  });

  it("executes exactly the approved amount even if the program changes its array after proposing", async () => {
    userTyped(session, ALICE);
    const w = watch(session);
    const code = `const a = [{ action: "transfer", to: "${ALICE}", token: "ETH", amount: parseEther("0.01") }];
const p = propose(a);
a.at(0).amount = parseEther("4");
await p;`;
    await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" });
    expect(w.approvals()[0].steps[0]).toMatchObject({ amount: (BigInt(10) ** BigInt(16)).toString() });
    expect(actionRows()).toMatchObject([{ amount: (BigInt(10) ** BigInt(16)).toString(), status: "confirmed" }]);
  });
});
