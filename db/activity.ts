import { getDb } from "./index";

export type ActivityRow = {
  id: number;
  kind: "transfer" | "sign_typed_data" | "swap";
  status: string;
  approvedBy: "user" | "auto" | null;
  symbol: string | null;
  decimals: number | null;
  amount: string | null;
  toAddress: string | null;
  toLabel: string | null;
  primaryType: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  createdAt: number;
  /** Swaps: the token bought, the least accepted and what arrived (base units). */
  symbolOut: string | null;
  decimalsOut: number | null;
  minOut: string | null;
  amountOut: string | null;
};

export function listActivity(limit = 200): ActivityRow[] {
  return getDb()
    .prepare(
      `SELECT a.id, a.kind, a.status, a.approved_by AS approvedBy,
              t.symbol, t.decimals, a.amount,
              a.to_address AS toAddress, a.to_label AS toLabel,
              a.td_primary_type AS primaryType, a.tx_hash AS txHash,
              n.explorer_url AS explorerUrl, a.created_at AS createdAt,
              o.symbol AS symbolOut, o.decimals AS decimalsOut, a.swap_min_out AS minOut, a.swap_amount_out AS amountOut
       FROM actions a
       JOIN networks n ON n.chain_id = a.chain_id
       LEFT JOIN tokens t ON t.id = a.token_id
       LEFT JOIN tokens o ON o.id = a.swap_token_out_id
       ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    )
    .all(limit) as ActivityRow[];
}
