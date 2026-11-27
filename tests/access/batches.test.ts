import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPlan } from "@/access";
import { expireSession, resolveApproval } from "@/approvals/registry";
import { assessSteps } from "@/lib/feasibility";
import { lockWallet } from "@/wallet";
import { setTransportFactoryForTests } from "@/wallet/clients";
import { fakeRpc } from "../helpers/fake-rpc";
import { ALICE, BOB, CAROL, actionRows, decoded, fromWebPage, newSession, resetDatabase, setupWallet, userTyped, watch } from "./helpers";

// Long plans: reviewed in batches of 20 (each approved whole or row by row),
// sent only after every batch is reviewed, one batch at a time.

let rpc: ReturnType<typeof fakeRpc>;
let session: string;

beforeEach(async () => {
  resetDatabase();
  lockWallet();
  rmSync(process.env.WALLET_KEYSTORE_PATH!, { force: true });
  rpc = fakeRpc();
  session = newSession();
  await setupWallet();
});
afterEach(() => setTransportFactoryForTests(null));

const many = (n: number, to = ALICE, amount = '"0.01"') =>
  `return Array.from({ length: ${n} }).map(() => ({ action: "transfer", to: "${to}", token: "ETH", amount: parseEther(${amount}) }));`;

describe("review in batches", () => {
  it("shows 45 transfers as three cards of 20, 20 and 5, then sends them all", async () => {
    userTyped(session, ALICE);
    const w = watch(session);
    expect(await runPlan({ sessionId: session, decoded: decoded(many(45)), mode: "sign" })).toBe("completed");
    const cards = w.approvals();
    expect(cards.map((c) => c.steps.length)).toEqual([20, 20, 5]);
    expect(cards.map((c) => c.review?.batch)).toEqual([1, 2, 3]);
    expect(cards.every((c) => c.review?.batchCount === 3 && c.review.totalSteps === 45)).toBe(true);
    expect(cards[1].steps[0].index).toBe(20);
    // Balances on each card are what is left after the earlier batches (5 ETH, minus 20 × (0.01 + fee)).
    expect(BigInt(cards[1].review!.balances.ETH)).toBeLessThan(BigInt(cards[0].review!.balances.ETH));
    expect(rpc.count("eth_sendRawTransaction")).toBe(45);
    expect(actionRows().every((r) => r.status === "confirmed")).toBe(true);
  });

  it("sends nothing until every batch has been reviewed", async () => {
    userTyped(session, ALICE);
    const sentWhenAsked: number[] = [];
    watch(session, () => {
      sentWhenAsked.push(rpc.count("eth_sendRawTransaction"));
      return "approved";
    });
    await runPlan({ sessionId: session, decoded: decoded(many(41)), mode: "sign" });
    expect(sentWhenAsked).toEqual([0, 0, 0]);
  });

  it("sends only the rows left ticked; unticked rows are recorded as rejected", async () => {
    userTyped(session, ALICE);
    watch(session, (request) => {
      if (request.kind !== "plan") return null;
      return { selected: request.steps.map((s) => s.index).filter((i) => i % 2 === 0) };
    });
    expect(await runPlan({ sessionId: session, decoded: decoded(many(25)), mode: "sign" })).toBe("completed");
    expect(rpc.count("eth_sendRawTransaction")).toBe(13);
    const statuses = actionRows().map((r) => r.status);
    expect(statuses.filter((s) => s === "confirmed")).toHaveLength(13);
    expect(statuses.filter((s) => s === "rejected")).toHaveLength(12);
    expect(statuses[1]).toBe("rejected");
  });

  it("cancelling batch 2 still sends batch 1 and leaves the rest out", async () => {
    userTyped(session, ALICE);
    const w = watch(session, (request) => (request.kind === "plan" && request.review?.batch === 2 ? "rejected" : "approved"));
    expect(await runPlan({ sessionId: session, decoded: decoded(many(45)), mode: "sign" })).toBe("completed");
    expect(w.approvals()).toHaveLength(2);
    expect(w.approvals()[1].review?.earlierApproved).toBe(true);
    expect(rpc.count("eth_sendRawTransaction")).toBe(20);
    const statuses = actionRows().map((r) => r.status);
    expect(statuses.slice(0, 20).every((s) => s === "confirmed")).toBe(true);
    expect(statuses.slice(20).every((s) => s === "rejected")).toBe(true);
  });

  it("sends nothing if a later card expires", async () => {
    userTyped(session, ALICE);
    const events = watch(session, (request) => {
      if (request.kind === "plan" && request.review?.batch === 2) {
        setTimeout(() => expireSession(session), 0);
        return null;
      }
      return "approved";
    });
    expect(await runPlan({ sessionId: session, decoded: decoded(many(30)), mode: "sign" })).toBe("cancelled");
    expect(events.approvals()).toHaveLength(2);
    expect(rpc.count("eth_sendRawTransaction")).toBe(0);
    expect(actionRows().every((r) => r.status === "expired")).toBe(true);
  });

  it("unticking a row that cannot be completed lets the rows after it run", async () => {
    // 5 ETH: 3 + 3 cannot both run; leaving out the second lets the third (1 ETH) run.
    userTyped(session, ALICE, BOB, CAROL);
    const w = watch(session, () => ({ selected: [0, 2] }));
    const code = `return [
      { action: "transfer", to: "${ALICE}", token: "ETH", amount: parseEther("3") },
      { action: "transfer", to: "${BOB}", token: "ETH", amount: parseEther("3") },
      { action: "transfer", to: "${CAROL}", token: "ETH", amount: parseEther("1") },
    ];`;
    expect(await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" })).toBe("completed");
    const [card] = w.approvals();
    expect(card.steps.map((s) => s.runnable)).toEqual([true, false, false]);
    expect(actionRows().map((r) => r.status)).toEqual(["confirmed", "rejected", "confirmed"]);
  });

  it("does not show later batches when an approved row cannot be completed (the prefix rule)", async () => {
    // 5 ETH; row 20 asks for 10 ETH and is approved anyway, so nothing after it can run.
    userTyped(session, ALICE, BOB);
    const w = watch(session);
    const code = `return Array.from({ length: 25 }).map((_, i) => i === 19
  ? { action: "transfer", to: "${BOB}", token: "ETH", amount: parseEther("10") }
  : { action: "transfer", to: "${ALICE}", token: "ETH", amount: parseEther("0.01") });`;
    const outcome = await runPlan({ sessionId: session, decoded: decoded(code), mode: "sign" });
    expect(outcome).toBe("completed");
    expect(w.approvals()).toHaveLength(1);
    expect(w.statuses().join(" ")).toMatch(/Steps 21–25 were not shown for approval: step 20 cannot be completed/);
    expect(rpc.count("eth_sendRawTransaction")).toBe(19);
  });

  it("marks document recipients with one summary line per card", async () => {
    fromWebPage(session, ALICE);
    const w = watch(session);
    await runPlan({ sessionId: session, decoded: decoded(many(25)), mode: "sign", external: true });
    const [first, second] = w.approvals();
    expect(first.warnings.map((x) => x.message)).toContain("20 addresses on this card came from a web page, document or pasted text, not typed by you.");
    expect(second.warnings.map((x) => x.message)).toContain("5 addresses on this card came from a web page, document or pasted text, not typed by you.");
  });

  it("refuses a selection naming a step that is not on the card", async () => {
    userTyped(session, ALICE);
    let accepted: boolean | null = null;
    watch(session, (request) => {
      accepted = resolveApproval(request.id, session, "approved", [999]);
      return "rejected";
    });
    await runPlan({ sessionId: session, decoded: decoded(many(3)), mode: "sign" });
    expect(accepted).toBe(false);
    expect(rpc.count("eth_sendRawTransaction")).toBe(0);
  });
});

describe("lines set aside from a document", () => {
  it("are listed on the first approval card only", async () => {
    userTyped(session, ALICE);
    const w = watch(session);
    const notices = ["1 line in Testing.pdf that may hold a payment was set aside and will not be paid. Check it against the document:", 'Line 38 (names only the sender): "x"'];
    await runPlan({ sessionId: session, decoded: decoded(many(25)), mode: "sign", setAsideNotices: notices });
    const [first, second] = w.approvals();
    expect(first.warnings.map((x) => x.message)).toEqual(expect.arrayContaining(notices));
    expect(second.warnings.some((x) => x.code.startsWith("set_aside_"))).toBe(false);
  });
});

describe("document tables in the access layer", () => {
  it("runs a program that reads external.rows, with every recipient marked as from the document", async () => {
    fromWebPage(session, ALICE, BOB);
    const w = watch(session);
    const rows = Array.from({ length: 25 }, (_, i) => [i % 2 ? BOB : ALICE, "0.01"]);
    const code = `const actions = [];
for (const row of external.rows("payments")) actions.push({ action: "transfer", to: row.recipient, token: "ETH", amount: parseEther(row.amount) });
await propose(actions);`;
    const outcome = await runPlan({
      sessionId: session,
      decoded: decoded(code),
      mode: "sign",
      tables: [{ name: "payments", columns: ["recipient", "amount"], rows }],
    });
    expect(outcome).toBe("completed");
    expect(w.approvals().map((c) => c.steps.length)).toEqual([20, 5]);
    expect(w.approvals()[0].steps.every((s) => s.kind === "transfer" && s.provenance === "external")).toBe(true);
    expect(rpc.count("eth_sendRawTransaction")).toBe(25);
    expect(actionRows().every((r) => r.provenance === "external")).toBe(true);
  });
});

describe("feasibility rules (shared with the approval card)", () => {
  const eth = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * BigInt(1e12);
  const steps = [
    { index: 0, kind: "transfer" as const, token: "ETH", decimals: 18, amount: eth("3") },
    { index: 1, kind: "transfer" as const, token: "ETH", decimals: 18, amount: eth("3") },
    { index: 2, kind: "transfer" as const, token: "ETH", decimals: 18, amount: eth("1") },
  ];
  it("blocks every step after the first that cannot be completed", () => {
    const r = assessSteps(steps, new Set(), { ETH: eth("5") });
    expect(r.verdicts.map((v) => v.state)).toEqual(["runnable", "blocked", "blocked"]);
    expect(r.verdicts[1].note).toMatch(/Not enough ETH: this step needs 3 ETH, and 2 ETH would be left by then/);
    expect(r.verdicts[2].note).toBe("Not run, because step 2 cannot be completed.");
  });
  it("frees balance for later steps when one is left out", () => {
    const r = assessSteps(steps, new Set([1]), { ETH: eth("5") });
    expect(r.verdicts.map((v) => v.state)).toEqual(["runnable", "excluded", "runnable"]);
    expect(r.balancesAfter.ETH).toBe(eth("1"));
  });
  it("counts a token transfer's fee against ETH", () => {
    const r = assessSteps(
      [{ index: 0, kind: "transfer", token: "USDC", decimals: 6, amount: BigInt(1_000_000), feeWei: eth("0.2") }],
      new Set(),
      { USDC: BigInt(5_000_000), ETH: eth("0.1") },
    );
    expect(r.verdicts[0]).toMatchObject({ state: "blocked", note: "Not enough ETH for the network fee of this step (up to 0.2 ETH)." });
  });
});

describe("conversation record of a long plan", () => {
  it("is a summary, not one line per step", async () => {
    const { planRecord } = await import("@/pipeline/record");
    const steps = Array.from({ length: 30 }, (_, i) => ({
      kind: "transfer" as const, token: "ETH", amount: BigInt(10) ** BigInt(16), decimals: 18, to: ALICE,
      status: i < 28 ? ("confirmed" as const) : ("rejected" as const),
    }));
    expect(planRecord({ mode: "sign", outcome: "completed", steps }, () => "[WALLET_ADDRESS_1]")).toBe(
      "(30 steps: 28 confirmed, 2 cancelled by the user. Sent in total: 0.28 ETH.)",
    );
  });
});
