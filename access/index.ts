import { randomUUID } from "node:crypto";
import { approvalTimeoutMs, expireSession, requestApproval, requestReview } from "@/approvals/registry";
import { formatUnits } from "viem";
import { getActiveNetwork, type Network } from "@/db/networks";
import { publish } from "@/events/bus";
import { audit } from "@/lib/logger";
import type { Mode } from "@/lib/modes";
import { bigintReplacer, type SandboxTable } from "@/lib/sandbox-prelude";
import type { DecodedResult } from "@/text-decoder";
import { WalletError, getWalletStatus } from "@/wallet";
import { assessSteps } from "@/lib/feasibility";
import { parseBatch, parseBatches } from "./actions";
import { analyzePlan, applyFeasibility, costSteps, type AnalysisContext } from "./analysis";
import { LIMITS } from "./config";
import { executeBatch, skippedStep, type ExecutedStep, type StepResult } from "./execute";
import { noActivity, type PlanActivity } from "@/lib/activity";
import { FeeBook } from "./fees";
import { checkShowContent, checkStepText, hostEstimateFee, hostGetBalance, hostGetHistory, hostLookupEns, hostQuoteSwap, hostResolveEns, ownAddress } from "./host";
import { recordStep, updateStep } from "./record";
import { runSandbox, type SandboxHost } from "./sandbox";
import { describeStep, previewCard, reviewInput } from "./templates";
import { AccessError, PlanBlocked, type Analysis, type Step } from "./types";
import { validatePlan } from "./validator";

// The Access Layer (docs/Access_layer.txt). The only component that decides
// whether anything is read, prepared or signed.
//
//   1. Validate the decoded program (same deterministic checks as the Code Verifier).
//   2. Dry run in the sandbox with real reads: propose() only records what the
//      program would do, so every action is known before anything happens.
//   3. Check all actions together: security, feasibility (the longest run of
//      steps that can be completed), saved limits.
//   4. explain / prepare: show what would happen. sign: get approval (or apply
//      saved limits), then run the program for real, executing exactly the
//      approved actions. If the program proposes something different on the
//      real run, that batch is checked and approved again on its own.
//
// Results go to the sandbox and the user only, never to a model.

export type PlanOutcome = "completed" | "cancelled" | "failed";

const globalForPlans = globalThis as unknown as { __runningPlans?: Map<string, AbortController> };
const running = (globalForPlans.__runningPlans ??= new Map());

export function hasRunningPlan(sessionId: string): boolean {
  return running.has(sessionId);
}

/** Cancels a session's running or paused plan and expires its approvals. */
export function cancelPlan(sessionId: string): void {
  running.get(sessionId)?.abort();
  expireSession(sessionId);
}

const READ_LABELS: Record<string, (args: unknown[]) => string> = {
  "wallet.getBalance": (args) => {
    const token = (args[0] as { token?: unknown } | undefined)?.token;
    return typeof token === "string" && /^[A-Za-z]{2,6}$/.test(token) ? `Reading your ${token.toUpperCase()} balance` : "Reading a balance";
  },
  "wallet.getHistory": () => "Reading your transaction history",
  "wallet.estimateFee": () => "Estimating the network fee",
  "wallet.quoteSwap": () => "Getting a Uniswap quote",
  "wallet.resolveEns": () => "Looking up an ENS name",
  "wallet.lookupEns": () => "Looking up the ENS name of an address",
};

/** A wallet read, shown as a detail line under the current step. Written by our code, not the program. */
async function trackedRead(name: string, args: unknown[], sessionId: string, fees: FeeBook, act: PlanActivity): Promise<unknown> {
  const label = READ_LABELS[name] as ((args: unknown[]) => string) | undefined;
  const id = label && !act.programStepsSuppressed ? act.start(label(args), { level: "detail" }) : "";
  try {
    const value = await hostRead(name, args, sessionId, fees);
    if (id) act.done(id);
    return value;
  } catch (error) {
    if (id) act.fail(id, error instanceof Error ? error.message : undefined);
    throw error;
  }
}

async function hostRead(name: string, args: unknown[], sessionId: string, fees: FeeBook): Promise<unknown> {
  switch (name) {
    case "wallet.estimateFee":
      return hostEstimateFee(args[0], sessionId, fees);
    case "wallet.quoteSwap":
      return hostQuoteSwap(args[0], fees);
    case "wallet.getBalance":
      return hostGetBalance(args[0]);
    case "wallet.getHistory":
      return hostGetHistory(args[0]);
    case "wallet.resolveEns":
      return hostResolveEns(args[0]);
    case "wallet.lookupEns":
      return hostLookupEns(args[0]);
    default:
      throw new AccessError(`${name} is not available.`);
  }
}

const sameActions = (a: unknown, b: unknown) => JSON.stringify(a, bigintReplacer) === JSON.stringify(b, bigintReplacer);

/** Waits until the wallet is unlocked. Returns false on timeout or cancellation. */
async function waitForUnlock(sessionId: string, signal: AbortSignal): Promise<boolean> {
  if ((await getWalletStatus()).unlocked) return true;
  publish(sessionId, { type: "unlock_required" });
  publish(sessionId, { type: "status", level: "info", text: "Unlock your wallet to continue." });
  const until = Date.now() + approvalTimeoutMs();
  while (Date.now() < until && !signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if ((await getWalletStatus()).unlocked) return true;
  }
  return false;
}

/**
 * What the user approved. `toRun`: steps to carry out (approved and, with
 * everything left out taken into account, possible). `leftOut`: steps the user
 * unticked or whose batch was cancelled. `status` is "approved" if anything is to run.
 */
type Approval = { status: "approved" | "rejected" | "expired" | "nothing"; by?: "user" | "auto"; toRun: Set<number>; leftOut: Set<number> };

const batchesOf = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/**
 * Auto-approval within saved limits, or the user's review, one card per batch of
 * LIMITS.reviewBatchSize steps. Before each card, feasibility is rechecked with
 * every step left out so far, so balances freed by unticked rows count. Nothing
 * is sent here: sending starts only after every batch has been reviewed.
 *
 * - Approve (all, or the ticked rows): the next batch is shown.
 * - Cancel: this batch and the rest are left out; batches already approved still run.
 * - Expired: nothing runs.
 * - If a step the user approved cannot be completed, the steps after it cannot run
 *   (the prefix rule), so the remaining batches are not shown.
 */
async function approve(sessionId: string, analysis: Analysis, network: Network, signer: string, signal: AbortSignal, act: PlanActivity): Promise<Approval> {
  const steps = analysis.steps;
  if (analysis.autoApprove) {
    publish(sessionId, { type: "status", level: "info", text: "Approved automatically: within your saved limits." });
    act.info("Approved automatically: within your saved limits");
    return { status: "approved", by: "auto", toRun: new Set(steps.map((s) => s.index)), leftOut: new Set() };
  }

  const batches = batchesOf(steps, LIMITS.reviewBatchSize);
  const costs = costSteps(steps);
  const leftOut = new Set<number>();
  const approved = new Set<number>();
  const final = () => {
    applyFeasibility(steps, analysis.balances, leftOut);
    return new Set(steps.filter((s) => s.runnable && approved.has(s.index)).map((s) => s.index));
  };

  for (const [b, batch] of batches.entries()) {
    const firstIndex = batch[0].index;
    const before = assessSteps(costs.filter((c) => c.index < firstIndex), leftOut, analysis.balances);
    if (before.firstFailure !== null) {
      // An approved step cannot be completed, so nothing after it can run: no point asking.
      for (const rest of batches.slice(b).flat()) leftOut.add(rest.index);
      const rows = `${firstIndex + 1}–${steps.length}`;
      publish(sessionId, { type: "status", level: "info", text: `Steps ${rows} were not shown for approval: step ${before.firstFailure + 1} cannot be completed, so no later step can run.` });
      act.info(`Steps ${rows} cannot run, because step ${before.firstFailure + 1} cannot be completed`);
      break;
    }
    applyFeasibility(steps, analysis.balances, leftOut);
    const card = reviewInput(sessionId, analysis, batch, network, signer, {
      batch: b + 1,
      batchCount: batches.length,
      totalSteps: steps.length,
      balances: before.balancesAfter,
      earlierApproved: approved.size > 0,
    });
    const waiting = act.wait(batches.length > 1 ? `Waiting for your approval of batch ${b + 1} of ${batches.length}` : "Waiting for your approval");
    const outcome = await requestReview(card, { signal });
    audit("access_review", { session: sessionId, batch: b + 1, of: batches.length, decision: outcome.decision, selected: outcome.selected?.length ?? (outcome.decision === "approved" ? batch.length : 0), shown: batch.length });

    if (outcome.decision === "expired" || outcome.decision === "keep") {
      // "keep" belongs to injection reviews and never reaches a plan card; treat it like no answer.
      act.fail(waiting, "Not approved in time");
      return { status: "expired", toRun: new Set(), leftOut: new Set(steps.map((s) => s.index)) };
    }
    if (outcome.decision === "rejected") {
      act.fail(waiting, "Cancelled by you");
      for (const rest of batches.slice(b).flat()) leftOut.add(rest.index);
      break;
    }
    const chosen = new Set(outcome.selected ?? batch.map((s) => s.index));
    for (const step of batch) (chosen.has(step.index) ? approved : leftOut).add(step.index);
    act.done(waiting, chosen.size === batch.length ? "Approved by you" : `Approved ${chosen.size} of ${batch.length} by you`);
  }

  const toRun = final();
  // "nothing": the user approved steps, but none of them can be completed.
  return { status: toRun.size > 0 ? "approved" : approved.size > 0 ? "nothing" : "rejected", by: "user", toRun, leftOut };
}

/** One step of what a plan did, for the conversation record. Contains real addresses: the caller masks them. */
export type ReportStep = {
  kind: "transfer" | "sign_typed_data" | "swap";
  token?: string;
  amount?: bigint;
  decimals?: number;
  /** Resolved address, or what the program wrote if it could not be resolved. */
  to?: string;
  primaryType?: string;
  /** Swaps: the token bought, and what arrived (or, if not known, the least accepted). */
  tokenOut?: string;
  amountOut?: bigint;
  decimalsOut?: number;
  status: "confirmed" | "submitted" | "signed" | "failed" | "skipped" | "not possible" | "rejected" | "expired" | "explained" | "prepared";
};

export type PlanReport = { mode: Mode; outcome: PlanOutcome; steps: ReportStep[] };

type PlanInput = {
  sessionId: string;
  decoded: DecodedResult;
  mode: Mode;
  /** The request read a web page or PDF: it always needs the user's approval. */
  external?: boolean;
  /** The user's message was pasted text: it also always needs the user's approval. */
  pasted?: boolean;
  /** Sentences the user chose to remove after the injection check, e.g. "2 flagged sentences were removed from the web page …". */
  injectionNotices?: string[];
  /** Document lines that may hold a payment but were set aside; shown on the first approval card. */
  setAsideNotices?: string[];
  /** The user's own typed messages for this request (not pasted ones): the only source of a swap slippage figure. */
  userTyped?: string[];
  /** Tables from documents for external.rows(), with addresses restored by the Text Decoder. */
  tables?: SandboxTable[];
  /** Receives what happened to each step, once the plan ends. */
  report?: (report: PlanReport) => void;
  /** The user's live activity stream. */
  activity?: PlanActivity;
};

export async function runPlan(input: PlanInput): Promise<PlanOutcome> {
  const steps: ReportStep[] = [];
  const outcome = await runPlanInner(input, steps);
  try {
    input.report?.({ mode: input.mode, outcome, steps });
  } catch {}
  return outcome;
}

const toReport = (step: Step, status: ReportStep["status"], received?: bigint): ReportStep =>
  step.kind === "transfer"
    ? { kind: "transfer", token: step.token, amount: step.amount, decimals: step.decimals, to: step.to ?? step.input, status }
    : step.kind === "swap"
      ? {
          kind: "swap", token: step.tokenIn, amount: step.side === "exact_in" ? step.amountIn : step.maxIn, decimals: step.decimalsIn,
          tokenOut: step.tokenOut, amountOut: received ?? step.minOut, decimalsOut: step.decimalsOut, status,
        }
      : { kind: "sign_typed_data", primaryType: step.knownType ?? step.primaryType, status };

async function runPlanInner(input: PlanInput, report: ReportStep[]): Promise<PlanOutcome> {
  const act = input.activity ?? noActivity;
  const { sessionId, decoded, mode } = input;
  const fromDocument = Boolean(input.external) || decoded.external_fields.length > 0 || (input.tables?.length ?? 0) > 0;
  const pasted = Boolean(input.pasted);
  const external = fromDocument || pasted;
  if (running.has(sessionId)) {
    publish(sessionId, { type: "status", level: "error", text: "Another request is still running." });
    return "failed";
  }
  const controller = new AbortController();
  running.set(sessionId, controller);
  const log = (event: string, detail: Record<string, unknown> = {}) => audit(`access_${event}`, { session: sessionId, ...detail });
  const error = (text: string) => publish(sessionId, { type: "status", level: "error", text });
  log("plan_started", { mode, external, pasted });

  try {
    // 1. Validate.
    const checking = act.start("Checking the program against the safety rules");
    const problems = validatePlan(decoded);
    if (problems.length > 0) {
      act.fail(checking, "It broke a safety rule, so it was not run");
      log("validation_failed", { problems: problems.slice(0, 5) });
      error("The plan did not pass the safety checks, so nothing was run.");
      return "failed";
    }

    act.done(checking);
    const network = getActiveNetwork();
    // One "current time" for the whole plan, so the dry run and the real run compute the same actions.
    const planNow = Date.now() / 1000;
    const wallet = await ownAddress();
    const fees = new FeeBook();
    const ctx: AnalysisContext = { sessionId, network, wallet, mode, fees, external, fromDocument, pasted, injectionNotices: input.injectionNotices, setAsideNotices: input.setAsideNotices, userTyped: input.userTyped };

    // 2. Dry run with real reads; propose() records only.
    const batches: unknown[] = [];
    const shownBefore: ReturnType<typeof checkShowContent>[] = [];
    let blockedReason: string | null = null;
    const recordBatch = (raw: unknown) => {
      try {
        parseBatch(raw, 0);
      } catch (e) {
        blockedReason ??= (e as Error).message;
        throw e;
      }
      batches.push(raw);
      const count = Array.isArray(raw) ? raw.length : 0;
      return { approved: true, status: "approved", results: Array.from({ length: count }, (_, i) => ({ index: i, status: "approved" })) };
    };
    const dryHost: SandboxHost = {
      async call(name, args) {
        return name === "propose" ? recordBatch(args[0]) : trackedRead(name, args, sessionId, fees, act);
      },
      step(text) {
        act.programStep(checkStepText(text));
      },
      show(content) {
        const checked = checkShowContent(content);
        if (batches.length === 0) shownBefore.push(checked);
      },
    };
    const running = act.start(mode === "sign" ? "Running the program on real data (nothing is sent yet)" : "Running the program on real data");
    const dry = await runSandbox(decoded.code, dryHost, controller.signal, { nowSeconds: planNow, tables: input.tables });
    act.finishProgramStep(dry.status === "failed" ? "failed" : "done");
    if (dry.status === "failed") act.fail(running, dry.reason);
    else act.done(running);
    if (dry.status === "failed") {
      log(dry.limit ? "limit_hit" : "program_failed", { reason: dry.reason });
      error(blockedReason ? `Blocked: ${blockedReason}` : dry.reason);
      return "failed";
    }
    if (Array.isArray(dry.value)) {
      try {
        recordBatch(dry.value);
      } catch (e) {
        error(`Blocked: ${(e as Error).message}`);
        return "failed";
      }
    }

    const showAll = (items: typeof shownBefore) => {
      for (const item of items) {
        if (item.list) publish(sessionId, { type: "output", content: { type: "list", title: item.title ?? item.text, items: item.list } });
        else publish(sessionId, { type: "output", content: { type: "text", text: [item.title, item.text].filter(Boolean).join("\n") } });
      }
    };

    // Nothing to sign or send: what the program showed is the whole result.
    if (batches.length === 0) {
      showAll(shownBefore);
      log("plan_finished", { outcome: "completed", actions: 0 });
      return "completed";
    }

    // 3. Check every action together.
    let analysis: Analysis;
    const assessing = act.start(mode === "explain" ? "Checking what this would do" : "Checking balances, fees and limits");
    try {
      analysis = await analyzePlan(ctx, parseBatches(batches));
    } catch (e) {
      act.fail(assessing, e instanceof Error ? e.message : undefined);
      if (e instanceof PlanBlocked) {
        log("blocked", { reason: e.message });
        error(`Blocked: ${e.message}`);
        return "failed";
      }
      if (e instanceof WalletError) {
        error(`The plan could not be checked: ${e.message}`);
        return "failed";
      }
      throw e;
    }
    log("analysis", { steps: analysis.steps.length, runnable: analysis.runnableCount, auto: analysis.autoApprove });
    const total = analysis.steps.length;
    const feasibility =
      analysis.runnableCount === total
        ? total === 1 ? "The step can be completed" : `All ${total} steps can be completed`
        : analysis.runnableCount === 0 ? "None of the steps can be completed" : `Only ${analysis.runnableCount} of ${total} steps can be completed`;
    if (analysis.runnableCount === 0) act.fail(assessing, feasibility);
    else act.done(assessing, undefined, feasibility);

    // The data the actions are based on, before anything is decided.
    showAll(shownBefore);

    // 4a. Explain or prepare: show, never sign.
    if (mode !== "sign") {
      for (const step of analysis.steps) report.push(toReport(step, step.runnable ? (mode === "explain" ? "explained" : "prepared") : "not possible"));
      publish(sessionId, { type: "steps", ...previewCard(analysis, network, mode) });
      act.info(mode === "explain" ? "Explained only: nothing was prepared, signed or sent" : "Prepared only: nothing was signed or sent");
      log("plan_finished", { outcome: "completed", mode });
      return "completed";
    }

    // 4b. Sign.
    const signer = wallet!;
    const planId = randomUUID();
    const rows = new Map<number, number | null>();
    for (const step of analysis.steps) {
      rows.set(step.index, recordStep({ sessionId, planId, network, signer, step, status: step.runnable ? "proposed" : "blocked", error: step.note }));
    }
    // Nothing to offer if no step could be completed even on its own (unticking others would not help).
    const possibleAlone = costSteps(analysis.steps).some((cost) => assessSteps([cost], new Set(), analysis.balances).firstFailure === null);
    if (analysis.runnableCount === 0 && !possibleAlone) {
      for (const step of analysis.steps) report.push(toReport(step, "not possible"));
      publish(sessionId, { type: "steps", ...previewCard(analysis, network, "prepare"), title: "Nothing can be completed", footer: "Nothing was signed or sent." });
      log("plan_finished", { outcome: "failed", reason: "nothing runnable" });
      return "failed";
    }

    const markAll = (steps: Step[], status: "rejected" | "expired") => steps.forEach((s) => updateStep(rows.get(s.index) ?? null, { status }));

    const needsUnlock = !(await getWalletStatus()).unlocked;
    const unlocking = needsUnlock ? act.wait("Waiting for the wallet to be unlocked") : "";
    const unlocked = await waitForUnlock(sessionId, controller.signal);
    if (needsUnlock) {
      if (unlocked) act.done(unlocking, "Wallet unlocked");
      else act.fail(unlocking, "Not unlocked in time");
    }
    if (!unlocked) {
      markAll(analysis.steps.filter((s) => s.runnable), "expired");
      for (const step of analysis.steps) report.push(toReport(step, step.runnable ? "expired" : "not possible"));
      error("The wallet was not unlocked in time, so nothing was signed.");
      return "cancelled";
    }
    // A slippage the user typed above their Settings value needs its own "are you sure" first.
    const risky = analysis.steps.filter(
      (s): s is Extract<Step, { kind: "swap" }> => s.kind === "swap" && s.runnable && s.slippageSource === "user" && s.slippageBps > s.settingsSlippageBps,
    );
    if (risky.length > 0) {
      const asking = act.wait("Waiting for you to confirm the higher slippage");
      const confirmed = await requestApproval(
        {
          kind: "slippage_confirm",
          sessionId,
          warnings: [],
          swaps: risky.map((s) => ({
            index: s.index,
            symbolIn: s.tokenIn,
            symbolOut: s.tokenOut,
            requestedBps: s.slippageBps,
            settingsBps: s.settingsSlippageBps,
            effect:
              s.side === "exact_in"
                ? `You could receive as little as ${formatUnits(s.minOut, s.decimalsOut)} ${s.tokenOut} (quote ${formatUnits(s.amountOut, s.decimalsOut)}).`
                : `You could pay as much as ${formatUnits(s.maxIn, s.decimalsIn)} ${s.tokenIn} (quote ${formatUnits(s.amountIn, s.decimalsIn)}).`,
          })),
        },
        { signal: controller.signal },
      );
      log("slippage_confirm", { decision: confirmed, swaps: risky.length });
      if (confirmed !== "approved") {
        act.fail(asking, confirmed === "expired" ? "Not confirmed in time" : "Not confirmed");
        const status = confirmed === "expired" ? "expired" : "rejected";
        applyFeasibility(analysis.steps, analysis.balances);
        markAll(analysis.steps.filter((s) => s.runnable), status);
        for (const step of analysis.steps) report.push(toReport(step, step.runnable ? status : "not possible"));
        publish(sessionId, { type: "status", level: "info", text: "Cancelled: the higher slippage was not confirmed. Nothing was signed or sent." });
        return "cancelled";
      }
      act.done(asking, "Higher slippage confirmed by you");
    }
    const decision = await approve(sessionId, analysis, network, signer, controller.signal, act);
    log("decision", { status: decision.status, by: decision.by, toRun: decision.toRun.size, leftOut: decision.leftOut.size, steps: analysis.steps.length });
    if (decision.status === "nothing") {
      for (const step of analysis.steps) {
        updateStep(rows.get(step.index) ?? null, decision.leftOut.has(step.index) ? { status: "rejected" } : { status: "blocked", error: step.note });
        report.push(toReport(step, decision.leftOut.has(step.index) ? "rejected" : "not possible"));
      }
      publish(sessionId, { type: "steps", ...previewCard(analysis, network, "prepare"), title: "Nothing can be completed", footer: "None of the steps you approved can be completed. Nothing was signed or sent." });
      log("plan_finished", { outcome: "failed", reason: "nothing approved is runnable" });
      return "failed";
    }
    if (decision.status !== "approved") {
      const status = decision.status === "expired" ? "expired" : "rejected";
      // Steps that could not have run anyway keep their "blocked" record.
      applyFeasibility(analysis.steps, analysis.balances);
      markAll(analysis.steps.filter((s) => s.runnable), status);
      for (const step of analysis.steps) report.push(toReport(step, step.runnable ? status : "not possible"));
      publish(sessionId, {
        type: "status",
        level: "info",
        text: decision.status === "expired" ? "The approval timed out. Nothing was signed or sent." : "Cancelled. Nothing was signed or sent.",
      });
      return "cancelled";
    }
    const approvedSteps = analysis.steps.filter((s) => decision.toRun.has(s.index));
    for (const step of analysis.steps) {
      const row = rows.get(step.index) ?? null;
      if (decision.toRun.has(step.index)) updateStep(row, { status: "approved", approvedBy: decision.by });
      else if (decision.leftOut.has(step.index)) updateStep(row, { status: "rejected" });
      else updateStep(row, { status: "blocked", error: step.note });
    }

    // The real run: execute exactly what was approved.
    const outcomes = new Map<number, ExecutedStep>();
    let failed = false;
    let replanned = false;
    let proposeIndex = 0;
    let extraIndex = analysis.steps.length;
    const extraSteps: Step[] = [];
    const extraLeftOut = new Set<number>();
    let proposedYet = false;

    // A step that could not be completed: not run, and its record stays "blocked".
    const blockedStep = (step: Step): ExecutedStep => ({
      result: { index: step.index, status: "skipped", error: "NOT_RUNNABLE" },
      line: { text: describeStep(step, network), state: "blocked", detail: step.note },
    });
    // A step the user unticked, or whose batch was cancelled: not run, recorded as rejected.
    const leftOutStep = (step: Step): ExecutedStep => ({
      result: { index: step.index, status: "skipped", error: "LEFT_OUT" },
      line: { text: describeStep(step, network), state: "skipped", detail: "Left out by you." },
    });
    const isLeftOut = (step: Step) => decision.leftOut.has(step.index) || extraLeftOut.has(step.index);

    /** Runs steps in review batches: each batch's approved steps are sent together (see executeBatch). */
    const runSteps = async (steps: Step[], allowed: (step: Step) => boolean, rowFor: (step: Step) => number | null): Promise<StepResult[]> => {
      const base = steps[0]?.index ?? 0;
      const groups = new Map<number, Step[]>();
      for (const step of steps) {
        const g = Math.floor((step.index - base) / LIMITS.reviewBatchSize);
        groups.set(g, [...(groups.get(g) ?? []), step]);
      }
      const groupCount = groups.size;
      for (const [g, group] of groups) {
        const todo: Step[] = [];
        for (const step of group) {
          if (failed) {
            const outcome = skippedStep(step, network, rowFor(step), "Not run, because an earlier step failed.");
            outcomes.set(step.index, outcome);
          } else if (isLeftOut(step)) {
            outcomes.set(step.index, leftOutStep(step));
          } else if (!allowed(step)) {
            outcomes.set(step.index, blockedStep(step));
          } else {
            todo.push(step);
          }
        }
        if (todo.length > 0 && !failed) {
          const single = todo.length === 1 ? todo[0] : null;
          const label = single
            ? `${single.kind === "transfer" ? "Sending" : "Signing"}: ${describeStep(single, network)}`
            : groupCount > 1
              ? `Sending batch ${g + 1} of ${groupCount}: ${todo.length} steps`
              : `Sending ${todo.length} steps`;
          const line = act.start(label);
          const results = await executeBatch(todo.map((step) => ({ step, rowId: rowFor(step) })), network, fees);
          results.forEach((outcome, i) => outcomes.set(todo[i].index, outcome));
          // A swap that is not confirmed also stops what comes after it: later steps may spend what it buys.
          const bad = results.filter((r) => r.result.status === "failed" || r.result.error === "SWAP_PENDING").length;
          const pending = results.filter((r) => r.result.status === "submitted").length;
          const skipped = results.filter((r) => r.result.status === "skipped").length;
          if (bad > 0) {
            failed = true;
            act.fail(line, single ? results[0].line.detail : `${bad} of ${todo.length} failed${skipped ? `, ${skipped} not sent` : ""}`);
          } else if (single) {
            act.done(line, undefined, results[0].result.status === "confirmed" ? "Confirmed" : results[0].result.status === "submitted" ? "Sent, not yet confirmed" : "Signed");
          } else {
            act.done(line, undefined, pending ? `${todo.length - pending} confirmed, ${pending} sent but not yet confirmed` : `All ${todo.length} done`);
          }
        }
      }
      const results = steps.map((step) => outcomes.get(step.index)!.result);
      for (const result of results) log("step_result", { index: result.index, status: result.status, error: result.error });
      return results;
    };

    const realPropose = async (raw: unknown) => {
      proposedYet = true;
      act.suppressProgramSteps(false);
      const i = proposeIndex++;
      if (!replanned && i < batches.length && sameActions(raw, batches[i])) {
        const steps = analysis.steps.filter((s) => s.batch === i);
        const results = await runSteps(steps, (s) => decision.toRun.has(s.index), (s) => rows.get(s.index) ?? null);
        const ran = results.some((r) => r.status !== "skipped");
        return { approved: ran, status: ran ? "approved" : "blocked", results };
      }

      // The program proposed something different from the check (for example a
      // balance changed). Check and approve this batch on its own.
      replanned = true;
      log("replanned", { batch: i });
      if (failed) return { approved: false, status: "blocked", results: [] };
      const parsed = parseBatch(raw, 0).map((action) => ({ action, batch: i }));
      const fresh = await analyzePlan(ctx, parsed);
      fresh.steps.forEach((s) => (s.index = extraIndex++));
      extraSteps.push(...fresh.steps);
      const freshRows = new Map(fresh.steps.map((s) => [s.index, recordStep({ sessionId, planId, network, signer, step: s, status: s.runnable ? "proposed" : "blocked", error: s.note })]));
      publish(sessionId, { type: "status", level: "info", text: "The plan changed after it was checked, so the next step needs approval again." });
      // Feasibility over the fresh steps uses positions from 0; the review uses their real indexes.
      const again = await approve(sessionId, fresh, network, signer, controller.signal, act);
      if (again.status !== "approved") {
        fresh.steps.forEach((s) => updateStep(freshRows.get(s.index) ?? null, { status: again.status === "expired" ? "expired" : "rejected" }));
        return { approved: false, status: again.status, results: [] };
      }
      for (const index of again.leftOut) extraLeftOut.add(index);
      fresh.steps.forEach((s) => {
        if (again.toRun.has(s.index)) updateStep(freshRows.get(s.index) ?? null, { status: "approved", approvedBy: again.by });
        else if (again.leftOut.has(s.index)) updateStep(freshRows.get(s.index) ?? null, { status: "rejected" });
      });
      const results = await runSteps(fresh.steps, (s) => again.toRun.has(s.index), (s) => freshRows.get(s.index) ?? null);
      return { approved: true, status: "approved", results };
    };

    const realHost: SandboxHost = {
      async call(name, args) {
        return name === "propose" ? realPropose(args[0]) : trackedRead(name, args, sessionId, fees, act);
      },
      step(text) {
        act.programStep(checkStepText(text));
      },
      show(content) {
        const checked = checkShowContent(content);
        // Output before the first proposal was already shown with the approval.
        if (proposedYet) showAll([checked]);
      },
    };
    // The real run repeats the dry run's narration up to its first proposal: hide that part.
    const executing = act.start("Running the approved program");
    act.suppressProgramSteps(true);
    const real = await runSandbox(decoded.code, realHost, controller.signal, {
      nowSeconds: planNow,
      tables: input.tables,
      wallClockMs: LIMITS.wallClockMs + approvedSteps.length * LIMITS.wallClockPerActionMs,
    });
    act.suppressProgramSteps(false);
    act.finishProgramStep(real.status === "failed" ? "failed" : "done");
    if (real.status === "completed" && Array.isArray(real.value)) await realPropose(real.value);

    // Approved steps the real run never reached are recorded as skipped.
    for (const step of approvedSteps) {
      if (!outcomes.has(step.index)) outcomes.set(step.index, skippedStep(step, network, rows.get(step.index) ?? null, "The program did not reach this step."));
    }
    for (const step of analysis.steps) {
      if (!outcomes.has(step.index)) outcomes.set(step.index, isLeftOut(step) ? leftOutStep(step) : blockedStep(step));
    }

    const allSteps = new Map<number, Step>(analysis.steps.map((step) => [step.index, step]));
    for (const step of extraSteps) allSteps.set(step.index, step);
    for (const [index, executed] of [...outcomes].sort((a, b) => a[0] - b[0])) {
      const step = allSteps.get(index);
      if (!step) continue;
      const status = executed.line.state === "blocked" ? "not possible" : executed.result.error === "LEFT_OUT" ? "rejected" : executed.result.status;
      report.push(toReport(step, status, executed.result.amountOut));
    }
    const lines = [...outcomes.values()].sort((a, b) => a.result.index - b.result.index).map((o) => o.line);
    const anyFailed = failed || real.status === "failed";
    if (anyFailed) act.fail(executing, real.status === "failed" ? real.reason : "A step failed");
    else act.done(executing);
    publish(sessionId, {
      type: "steps",
      title: anyFailed ? "Finished with problems" : "Done",
      steps: lines,
      footer: real.status === "failed" ? real.reason : undefined,
    });
    const outcome: PlanOutcome = anyFailed ? "failed" : "completed";
    log("plan_finished", { outcome });
    return outcome;
  } catch (e) {
    log("plan_error", { error: e instanceof Error ? e.name : "Error" });
    error(e instanceof AccessError || e instanceof PlanBlocked ? e.message : "The plan stopped because of an unexpected error. Nothing more was signed or sent.");
    return "failed";
  } finally {
    running.delete(sessionId);
  }
}
