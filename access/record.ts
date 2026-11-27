import { getDb } from "@/db";
import type { Network } from "@/db/networks";
import type { Step } from "./types";

// The access layer's record of every action in sign mode, in the `actions`
// table. The Activity page, wallet.getHistory() and spend totals read it.
// Signatures are never stored.

export type TokenRow = { id: number; symbol: string; address: string | null; decimals: number };

export function tokenRow(chainId: number, symbol: string): TokenRow | undefined {
  return getDb()
    .prepare("SELECT id, symbol, address, decimals FROM tokens WHERE chain_id = ? AND symbol = ? COLLATE NOCASE")
    .get(chainId, symbol) as TokenRow | undefined;
}

export type SpendLimit = { perTxMax: bigint; dailyMax: bigint; weeklyMax: bigint };

/** The enabled spend limit for a token, or null if none is set (always ask). */
export function spendLimit(tokenId: number): SpendLimit | null {
  const row = getDb()
    .prepare("SELECT per_tx_max AS perTx, daily_max AS daily, weekly_max AS weekly FROM spend_limits WHERE token_id = ? AND enabled = 1")
    .get(tokenId) as { perTx: string; daily: string; weekly: string } | undefined;
  return row ? { perTxMax: BigInt(row.perTx), dailyMax: BigInt(row.daily), weeklyMax: BigInt(row.weekly) } : null;
}

/** Amount of a token committed in the last `seconds` (approved or sent), in base units. */
export function spentSince(tokenId: number, seconds: number): bigint {
  const rows = getDb()
    .prepare(
      `SELECT amount FROM actions
       WHERE kind = 'transfer' AND token_id = ? AND created_at >= unixepoch() - ?
         AND status IN ('approved', 'signed', 'submitted', 'confirmed')`,
    )
    .all(tokenId, seconds) as { amount: string }[];
  return rows.reduce((sum, row) => sum + BigInt(row.amount), BigInt(0));
}

/** Inserts a step. Returns the row id, or null if the step cannot be stored (e.g. unresolved recipient). */
export function recordStep(input: {
  sessionId: string;
  planId: string;
  network: Network;
  signer: string;
  step: Step;
  status: "proposed" | "blocked";
  error?: string;
}): number | null {
  const { step } = input;
  const base = {
    session: input.sessionId,
    plan: input.planId,
    index: step.index,
    chain: input.network.chainId,
    signer: input.signer,
    status: input.status,
    error: input.error ?? null,
  };
  if (step.kind === "transfer") {
    if (!step.to || step.tokenId === null) return null;
    return Number(
      getDb()
        .prepare(
          `INSERT INTO actions (session_id, plan_id, batch_index, kind, chain_id, signer_address, token_id, to_address,
             to_label, to_provenance, amount, status, tainted, fee_wei, error)
           VALUES (@session, @plan, @index, 'transfer', @chain, @signer, @tokenId, @to, @label, @provenance, @amount,
             @status, @tainted, @fee, @error)`,
        )
        .run({
          ...base,
          tokenId: step.tokenId,
          to: step.to,
          label: step.label ?? null,
          provenance: step.provenance,
          amount: step.amount.toString(),
          tainted: step.provenance === "user" || step.provenance === "contact" ? 0 : 1,
          fee: step.feeWei?.toString() ?? null,
        }).lastInsertRowid,
    );
  }
  if (step.kind === "swap") {
    if (step.tokenInId === null || step.tokenOutId === null || step.feeTier === undefined) return null;
    return Number(
      getDb()
        .prepare(
          `INSERT INTO actions (session_id, plan_id, batch_index, kind, chain_id, signer_address, token_id, amount,
             swap_token_out_id, swap_side, swap_min_out, swap_fee_tier, status, fee_wei, error)
           VALUES (@session, @plan, @index, 'swap', @chain, @signer, @tokenIn, @maxIn, @tokenOut, @side, @minOut, @feeTier,
             @status, @fee, @error)`,
        )
        .run({
          ...base,
          tokenIn: step.tokenInId,
          maxIn: step.maxIn.toString(),
          tokenOut: step.tokenOutId,
          side: step.side,
          minOut: step.minOut.toString(),
          feeTier: step.feeTier,
          fee: step.feeWei?.toString() ?? null,
        }).lastInsertRowid,
    );
  }
  if (!step.digest) return null;
  return Number(
    getDb()
      .prepare(
        `INSERT INTO actions (session_id, plan_id, batch_index, kind, chain_id, signer_address, td_primary_type, td_domain,
           td_hash, status, error)
         VALUES (@session, @plan, @index, 'sign_typed_data', @chain, @signer, @primaryType, @domain, @digest, @status, @error)`,
      )
      .run({
        ...base,
        primaryType: step.primaryType,
        domain: JSON.stringify(step.domain, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        digest: step.digest,
      }).lastInsertRowid,
  );
}

export type StepUpdate = {
  status: "approved" | "rejected" | "expired" | "signed" | "submitted" | "confirmed" | "failed" | "skipped" | "blocked";
  approvedBy?: "user" | "auto";
  txHash?: string;
  blockNumber?: bigint | null;
  feeWei?: bigint | null;
  error?: string;
  /** Swaps: what actually arrived. */
  amountOut?: bigint | null;
};

export function updateStep(id: number | null, update: StepUpdate): void {
  if (id === null) return;
  getDb()
    .prepare(
      `UPDATE actions SET status = @status,
         approved_by = COALESCE(@approvedBy, approved_by),
         tx_hash = COALESCE(@txHash, tx_hash),
         block_number = COALESCE(@blockNumber, block_number),
         fee_wei = COALESCE(@feeWei, fee_wei),
         error = COALESCE(@error, error),
         swap_amount_out = COALESCE(@amountOut, swap_amount_out),
         updated_at = unixepoch()
       WHERE id = @id`,
    )
    .run({
      id,
      status: update.status,
      approvedBy: update.approvedBy ?? null,
      txHash: update.txHash ?? null,
      blockNumber: update.blockNumber === undefined || update.blockNumber === null ? null : Number(update.blockNumber),
      feeWei: update.feeWei === undefined || update.feeWei === null ? null : update.feeWei.toString(),
      error: update.error ?? null,
      amountOut: update.amountOut === undefined || update.amountOut === null ? null : update.amountOut.toString(),
    });
}
