import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PlanApproval } from "@/approvals/types";

vi.mock("@/hooks/use-approvals", () => ({ useApprovals: () => ({ approve: vi.fn(), approveSelected: vi.fn(), reject: vi.fn(), keep: vi.fn(), pending: [] }) }));
const { ApprovalCard } = await import("@/components/approval-card");

const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const eth = (n: number) => (BigInt(Math.round(n * 1e6)) * BigInt(1e12)).toString();
const step = (index: number, amount: number) => ({
  kind: "transfer" as const, index, symbol: "ETH", decimals: 18, amount: eth(amount), to: ALICE, provenance: "external" as const,
  feeWei: "42000000000000", runnable: true,
});

const card = (steps: ReturnType<typeof step>[], batch = 1, batchCount = 2, balance = 5): PlanApproval => ({
  id: "a", sessionId: "s", network: "Sepolia", signer: ALICE, warnings: [{ code: "recipients_external", message: "2 addresses on this card came from a web page, document or pasted text, not typed by you." }],
  createdAt: Date.now(), expiresAt: Date.now() + 300_000, kind: "plan", steps, runnableCount: steps.length,
  review: { batch, batchCount, totalSteps: 22, balances: { ETH: eth(balance) }, earlierApproved: batch > 1 },
});

describe("batch approval card", () => {
  it("shows the batch, a checkbox per step, totals and the batch buttons", () => {
    const html = renderToStaticMarkup(<ApprovalCard request={card([step(20, 0.5), step(21, 1)], 2)} decision={null} />);
    expect(html).toContain("Batch 2 of 2 · steps 21–22 of 22");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("Step 21");
    expect(html).toContain("1.5 ETH");
    expect(html).toContain("Cancel remaining");
    expect(html).toContain("Approve all");
    expect(html).not.toContain("Approve selected");
    expect(html).toContain("Cancelling keeps the batches you already approved");
  });

  it("rechecks feasibility from the card's balances (3 + 3 from 5 ETH)", () => {
    const html = renderToStaticMarkup(<ApprovalCard request={card([step(0, 3), step(1, 3)], 1, 1)} decision={null} />);
    expect(html).toContain("Will not run");
    expect(html).toContain("Only 1 of the 2 ticked steps can be completed.");
    expect(html).toContain("Cancel");
  });

  it("shows how many steps were approved once decided", () => {
    const html = renderToStaticMarkup(<ApprovalCard request={card([step(0, 0.1), step(1, 0.1)])} decision="approved" selected={[0]} />);
    expect(html).toContain("Approved 1 of 2");
    expect(html).toContain("Left out");
  });
});
