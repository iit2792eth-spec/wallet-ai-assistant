"use client";

import { useEffect, useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { ApprovalDecision, PlanApproval, PlanStep, TransferApproval, TypedDataApproval, SigningApprovalRequest } from "@/approvals/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useApprovals } from "@/hooks/use-approvals";
import { formatAmount } from "@/lib/format";
import { assessSteps, formatBase, type CostStep } from "@/lib/feasibility";

export const DECISION_LABELS: Record<ApprovalDecision, string> = {
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
  // Only an injection review can resolve to "keep"; a signing card never shows this.
  keep: "Continued",
};

export function Countdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return (
    <span className="font-mono text-xs text-muted-foreground tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

const SOURCE_LABELS = {
  external: "From a web page, document or pasted text",
  untrusted: "Not typed by you and not a saved contact",
} as const;

function Recipient({ to, label, untrusted, source }: { to: string; label?: string; untrusted: boolean; source?: keyof typeof SOURCE_LABELS }) {
  return (
    <div className="flex flex-col gap-0.5">
      {label && <span>{label}</span>}
      <span className="font-mono text-xs break-all">{to}</span>
      {untrusted && <span className="text-xs text-warning">{source ? SOURCE_LABELS[source] : "Untrusted source"}</span>}
    </div>
  );
}

function TransferDetails({ request }: { request: TransferApproval }) {
  const { transfers } = request;
  const totals = new Map<string, { sum: bigint; decimals: number }>();
  for (const transfer of transfers) {
    const entry = totals.get(transfer.symbol) ?? { sum: BigInt(0), decimals: transfer.decimals };
    entry.sum += BigInt(transfer.amount);
    totals.set(transfer.symbol, entry);
  }

  return (
    <dl className="divide-y">
      {transfers.length === 1 ? (
        <>
          <Row label="Amount">
            <span className="font-mono">
              {formatAmount(transfers[0].amount, transfers[0].decimals)} {transfers[0].symbol}
            </span>
          </Row>
          <Row label="To">
            <Recipient
              to={transfers[0].to}
              label={transfers[0].toLabel}
              untrusted={transfers[0].provenance === "untrusted"}
            />
          </Row>
        </>
      ) : (
        <>
          {transfers.map((transfer, index) => (
            <Row key={index} label={`Transfer ${index + 1}`}>
              <div className="flex flex-col gap-1">
                <span className="font-mono">
                  {formatAmount(transfer.amount, transfer.decimals)} {transfer.symbol}
                </span>
                <Recipient
                  to={transfer.to}
                  label={transfer.toLabel}
                  untrusted={transfer.provenance === "untrusted"}
                />
              </div>
            </Row>
          ))}
          <Row label="Total">
            <div className="flex flex-col font-mono">
              {[...totals].map(([symbol, { sum, decimals }]) => (
                <span key={symbol}>
                  {formatAmount(sum.toString(), decimals)} {symbol}
                </span>
              ))}
            </div>
          </Row>
        </>
      )}
      {request.estimatedFeeWei && (
        <Row label="Fee (est.)">
          <span className="font-mono">{formatAmount(request.estimatedFeeWei, 18)} ETH</span>
        </Row>
      )}
    </dl>
  );
}

function display(value: unknown): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : String(value);
}

function Fields({ title, fields }: { title: string; fields: Record<string, unknown> }) {
  return (
    <div>
      <div className="pt-2 pb-1 text-xs text-muted-foreground">{title}</div>
      <dl className="divide-y">
        {Object.entries(fields).map(([key, value]) => (
          <Row key={key} label={key}>
            <span className="font-mono text-xs break-all whitespace-pre-wrap">{display(value)}</span>
          </Row>
        ))}
      </dl>
    </div>
  );
}

function PlanStepDetails({
  step,
  number,
  select,
}: {
  step: PlanStep;
  number: number;
  /** Batch review: the row's checkbox. */
  select?: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void };
}) {
  const leftOut = select !== undefined && !select.checked;
  return (
    <div className={step.runnable && !leftOut ? "py-2" : "py-2 opacity-60"}>
      <div className="flex items-center gap-2 pb-1">
        {select ? (
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={select.checked}
              disabled={select.disabled}
              onChange={(event) => select.onChange(event.target.checked)}
            />
            <span className="font-medium">Step {number}</span>
          </label>
        ) : (
          <span className="font-medium">Step {number}</span>
        )}
        {leftOut ? <Badge variant="outline">Left out</Badge> : !step.runnable && <Badge variant="outline">Will not run</Badge>}
      </div>
      {!leftOut && !step.runnable && step.note && <p className="pb-1 text-xs text-warning">{step.note}</p>}
      {step.kind === "transfer" ? (
        <dl>
          <Row label="Amount">
            <span className="font-mono">
              {formatAmount(step.amount, step.decimals)} {step.symbol}
            </span>
          </Row>
          <Row label="To">
            <Recipient
              to={step.to}
              label={step.toLabel}
              untrusted={step.provenance === "external" || step.provenance === "untrusted"}
              source={step.provenance === "external" || step.provenance === "untrusted" ? step.provenance : undefined}
            />
          </Row>
          {step.feeWei && (
            <Row label="Fee (est.)">
              <span className="font-mono">up to {formatAmount(step.feeWei, 18)} ETH</span>
            </Row>
          )}
        </dl>
      ) : step.kind === "swap" ? (
        <SwapDetails step={step} />
      ) : (
        <div className="flex flex-col gap-1">
          <dl>
            <Row label="Type">
              <span className="font-mono">{step.knownType ?? step.primaryType}</span>
            </Row>
            {step.summary && <Row label="Means">{step.summary}</Row>}
          </dl>
          <Fields title="Domain" fields={step.domain} />
          <Fields title="Message" fields={step.message} />
        </div>
      )}
    </div>
  );
}

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

function SwapDetails({ step }: { step: Extract<PlanStep, { kind: "swap" }> }) {
  const exactIn = step.side === "exact_in";
  return (
    <dl>
      <Row label={exactIn ? "Pay" : "Pay at most"}>
        <span className="font-mono">
          {formatAmount(exactIn ? step.amountIn : step.maxIn, step.decimalsIn)} {step.symbolIn}
        </span>
      </Row>
      <Row label={exactIn ? "Receive at least" : "Receive exactly"}>
        <span className="font-mono">
          {formatAmount(exactIn ? step.minOut : step.amountOut, step.decimalsOut)} {step.symbolOut}
        </span>
      </Row>
      <Row label="Quote">
        <span className="font-mono">
          {exactIn
            ? `${formatAmount(step.amountOut, step.decimalsOut)} ${step.symbolOut}`
            : `${formatAmount(step.amountIn, step.decimalsIn)} ${step.symbolIn}`}
        </span>
      </Row>
      <Row label="Slippage">
        <span>
          {pct(step.slippageBps)}{" "}
          <span className="text-xs text-muted-foreground">{step.slippageSource === "user" ? "(you asked for this)" : "(your setting)"}</span>
        </span>
      </Row>
      {step.feeTier !== undefined && (
        <Row label="Pool">
          <span>Uniswap v3 · {pct(step.feeTier / 100)} fee</span>
        </Row>
      )}
      {step.priceImpactBps !== undefined && (
        <Row label="Price impact">
          <span className={step.priceImpactBps > 200 ? "text-warning" : undefined}>{pct(step.priceImpactBps)}</span>
        </Row>
      )}
      <Row label="Recipient">
        <span>Your wallet</span>
      </Row>
      {step.feeWei && (
        <Row label="Fee (est.)">
          <span className="font-mono">up to {formatAmount(step.feeWei, 18)} ETH</span>
        </Row>
      )}
    </dl>
  );
}

/** The card's steps rechecked with the unticked ones left out: the same rules the server applies (lib/feasibility.ts). */
function useLiveSteps(request: PlanApproval, ticked: ReadonlySet<number>): PlanStep[] {
  return useMemo(() => {
    if (!request.review) return request.steps;
    const costs: CostStep[] = request.steps.map((step) =>
      step.kind === "transfer"
        ? { index: step.index, kind: "transfer", token: step.symbol, decimals: step.decimals, amount: BigInt(step.amount), feeWei: step.feeWei ? BigInt(step.feeWei) : undefined, problem: step.problem }
        : step.kind === "swap"
          ? {
              index: step.index, kind: "swap", token: step.symbolIn, decimals: step.decimalsIn, amount: BigInt(step.maxIn),
              feeWei: step.feeWei ? BigInt(step.feeWei) : undefined, problem: step.problem, tokenOut: step.symbolOut, minOut: BigInt(step.minOut),
            }
          : { index: step.index, kind: "sign_typed_data", problem: step.problem },
    );
    const balances = Object.fromEntries(Object.entries(request.review.balances).map(([k, v]) => [k, BigInt(v)]));
    const left = new Set(request.steps.map((s) => s.index).filter((i) => !ticked.has(i)));
    const { verdicts } = assessSteps(costs, left, balances);
    return request.steps.map((step, i) => ({ ...step, runnable: verdicts[i].state === "runnable", note: verdicts[i].note ?? step.note }));
  }, [request, ticked]);
}

function selectionTotals(steps: PlanStep[], ticked: ReadonlySet<number>) {
  const totals = new Map<string, { sum: bigint; decimals: number }>();
  let fee = BigInt(0);
  for (const step of steps) {
    if (!ticked.has(step.index) || !step.runnable || step.kind === "typed_data") continue;
    // A swap counts at the most it may pay.
    const [symbol, decimals, amount] = step.kind === "transfer" ? [step.symbol, step.decimals, step.amount] : [step.symbolIn, step.decimalsIn, step.maxIn];
    const entry = totals.get(symbol) ?? { sum: BigInt(0), decimals };
    entry.sum += BigInt(amount);
    totals.set(symbol, entry);
    if (step.feeWei) fee += BigInt(step.feeWei);
  }
  return { totals: [...totals].map(([symbol, { sum, decimals }]) => `${formatBase(sum, decimals)} ${symbol}`), fee };
}

function PlanDetails({
  request,
  steps,
  ticked,
  onTick,
}: {
  request: PlanApproval;
  steps: PlanStep[];
  ticked?: ReadonlySet<number>;
  onTick?: (index: number, checked: boolean) => void;
}) {
  // Checkboxes stay visible once decided (read-only), so left-out rows still read as left out.
  const selectable = Boolean(ticked && request.steps.length > 1);
  if (selectable) {
    const { totals, fee } = selectionTotals(steps, ticked!);
    return (
      <div className="divide-y">
        {steps.map((step) => (
          <PlanStepDetails
            key={step.index}
            step={step}
            number={step.index + 1}
            select={{ checked: ticked!.has(step.index), disabled: !onTick, onChange: (checked) => onTick?.(step.index, checked) }}
          />
        ))}
        <dl>
          <Row label="Selected">
            <div className="flex flex-col font-mono">
              {totals.length ? totals.map((t) => <span key={t}>{t}</span>) : <span className="text-muted-foreground">Nothing that can run</span>}
            </div>
          </Row>
          {fee > BigInt(0) && (
            <Row label="Total fee">
              <span className="font-mono">up to {formatAmount(fee.toString(), 18)} ETH</span>
            </Row>
          )}
        </dl>
      </div>
    );
  }
  return (
    <div className="divide-y">
      {steps.map((step, index) => (
        <PlanStepDetails key={index} step={step} number={request.review ? step.index + 1 : index + 1} />
      ))}
      {request.estimatedFeeWei && (
        <dl>
          <Row label="Total fee">
            <span className="font-mono">up to {formatAmount(request.estimatedFeeWei, 18)} ETH</span>
          </Row>
        </dl>
      )}
    </div>
  );
}

function planTitle(request: PlanApproval): string {
  const swaps = request.steps.filter((s) => s.kind === "swap").length;
  if (swaps > 0) return swaps === request.steps.length ? (swaps === 1 ? "Swap" : `${swaps} swaps`) : `${request.review?.totalSteps ?? request.steps.length} steps`;
  const transfers = request.steps.filter((s) => s.kind === "transfer").length;
  const signatures = request.steps.length - transfers;
  if (signatures === 0) return transfers === 1 ? "Transfer" : `${transfers} transfers`;
  if (transfers === 0) return signatures === 1 ? "Sign message" : `${signatures} signatures`;
  return `${request.steps.length} steps`;
}

function approveLabel(request: SigningApprovalRequest): string {
  if (request.kind !== "plan" || request.runnableCount === request.steps.length) return "Approve";
  return request.runnableCount === 1 ? "Approve step 1" : `Approve steps 1–${request.runnableCount}`;
}

function TypedDataDetails({ request }: { request: TypedDataApproval }) {
  return (
    <div className="flex flex-col gap-1">
      <dl>
        <Row label="Type">
          <span className="font-mono">{request.primaryType}</span>
          {!request.knownType && <span className="ml-2 text-xs text-warning">Unknown type</span>}
        </Row>
      </dl>
      <Fields title="Domain" fields={request.domain} />
      <Fields title="Message" fields={request.message} />
    </div>
  );
}

export function ApprovalCard({
  request,
  decision,
  selected,
}: {
  request: SigningApprovalRequest;
  decision: ApprovalDecision | null;
  /** For a decided batch card: the steps the user left ticked (absent = all). */
  selected?: number[];
}) {
  const { approve, approveSelected, reject } = useApprovals();
  const [busy, setBusy] = useState(false);
  const plan = request.kind === "plan" ? request : null;
  const review = plan?.review;
  const allIndexes = useMemo(() => (plan ? plan.steps.map((s) => s.index) : []), [plan]);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(() => new Set(selected ?? allIndexes));
  const shownTicked = decision === null ? ticked : new Set(selected ?? allIndexes);
  const liveSteps = useLiveSteps(plan ?? ({ steps: [] } as unknown as PlanApproval), shownTicked);
  const selectable = Boolean(review && plan && plan.steps.length > 1);
  const allTicked = ticked.size === allIndexes.length;

  async function answer(act: (id: string) => Promise<void>) {
    setBusy(true);
    await act(request.id);
    setBusy(false);
  }
  const tick = (index: number, checked: boolean) =>
    setTicked((current) => {
      const next = new Set(current);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  const liveRunnable = liveSteps.filter((s) => s.runnable && shownTicked.has(s.index)).length;
  // On a batch card the "only N can be completed" line follows the ticks live.
  const partial =
    selectable && liveRunnable < shownTicked.size
      ? [{ code: "partial", message: `Only ${liveRunnable} of the ${shownTicked.size} ticked steps can be completed.` }]
      : !selectable && review && liveRunnable < liveSteps.length
        ? request.warnings.filter((w) => w.code === "partial")
        : [];
  const shownWarnings = review ? [...partial, ...request.warnings.filter((w) => w.code !== "partial")] : request.warnings;

  const title =
    request.kind === "plan"
      ? planTitle(request)
      : request.kind === "typed_data"
        ? "Sign message"
        : request.transfers.length > 1
          ? `${request.transfers.length} transfers`
          : "Transfer";

  return (
    <div className="rounded-lg border bg-card text-sm">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span className="font-medium">{title}</span>
          <span className="text-muted-foreground">{request.network}</span>
          {review && review.batchCount > 1 && (
            <span className="text-xs text-muted-foreground">
              Batch {review.batch} of {review.batchCount} · steps {plan!.steps[0].index + 1}–{plan!.steps.at(-1)!.index + 1} of {review.totalSteps}
            </span>
          )}
        </div>
        {decision === null && <Countdown expiresAt={request.expiresAt} />}
      </div>

      {shownWarnings.length > 0 && (
        <ul className="flex flex-col gap-1 border-b px-4 py-2.5 text-warning">
          {shownWarnings.map((warning) => (
            <li key={warning.code} className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {warning.message}
            </li>
          ))}
        </ul>
      )}

      <div className="px-4 py-1.5">
        {request.kind === "plan" ? (
          <PlanDetails
            request={request}
            steps={review ? liveSteps : request.steps}
            ticked={selectable ? shownTicked : undefined}
            onTick={selectable && decision === null && !busy ? tick : undefined}
          />
        ) : request.kind === "transfer" ? (
          <TransferDetails request={request} />
        ) : (
          <TypedDataDetails request={request} />
        )}
      </div>

      {review?.earlierApproved && decision === null && (
        <p className="border-t px-4 pt-2 text-xs text-muted-foreground">Cancelling keeps the batches you already approved; they are sent after this.</p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-2.5">
        {decision === null ? (
          selectable ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => void answer(reject)}>
                {review!.batchCount > 1 ? "Cancel remaining" : "Cancel"}
              </Button>
              {!allTicked && (
                <Button variant="outline" disabled={busy} onClick={() => void answer((id) => approveSelected(id, [...ticked]))}>
                  {ticked.size === 0 ? "Skip this batch" : `Approve selected (${ticked.size})`}
                </Button>
              )}
              <Button disabled={busy} onClick={() => void answer(approve)}>
                Approve all
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => void answer(reject)}>
                {request.kind === "plan" && request.runnableCount < request.steps.length ? "Cancel" : "Reject"}
              </Button>
              <Button disabled={busy} onClick={() => void answer(approve)}>
                {approveLabel(request)}
              </Button>
            </>
          )
        ) : (
          <Badge variant={decision === "approved" ? "default" : "outline"}>
            {decision === "approved" && selected && plan && selected.length < plan.steps.length
              ? `Approved ${selected.length} of ${plan.steps.length}`
              : DECISION_LABELS[decision]}
          </Badge>
        )}
      </div>
    </div>
  );
}
