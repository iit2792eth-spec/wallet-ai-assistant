import { getDb } from "./index";

/** A token on the given chain, with its spend limit if one is set. Amounts are smallest-unit strings. */
export type TokenLimit = {
  tokenId: number;
  symbol: string;
  decimals: number;
  perTxMax: string | null;
  dailyMax: string | null;
  weeklyMax: string | null;
  enabled: boolean;
};

export type LimitInput = { perTxMax: string; dailyMax: string; weeklyMax: string; enabled: boolean };

type Row = Omit<TokenLimit, "enabled"> & { enabled: number | null };

export function listTokenLimits(chainId: number): TokenLimit[] {
  const rows = getDb()
    .prepare(
      `SELECT t.id AS tokenId, t.symbol, t.decimals,
              l.per_tx_max AS perTxMax, l.daily_max AS dailyMax,
              l.weekly_max AS weeklyMax, l.enabled
       FROM tokens t LEFT JOIN spend_limits l ON l.token_id = t.id
       WHERE t.chain_id = ? ORDER BY t.id`,
    )
    .all(chainId) as Row[];
  return rows.map((row) => ({ ...row, enabled: row.enabled === 1 }));
}

export function getToken(tokenId: number): { id: number; decimals: number } | undefined {
  return getDb().prepare("SELECT id, decimals FROM tokens WHERE id = ?").get(tokenId) as
    | { id: number; decimals: number }
    | undefined;
}

export function upsertLimit(tokenId: number, input: LimitInput): void {
  getDb()
    .prepare(
      `INSERT INTO spend_limits (token_id, per_tx_max, daily_max, weekly_max, enabled)
       VALUES (@tokenId, @perTxMax, @dailyMax, @weeklyMax, @enabled)
       ON CONFLICT (token_id) DO UPDATE SET
         per_tx_max = excluded.per_tx_max, daily_max = excluded.daily_max,
         weekly_max = excluded.weekly_max, enabled = excluded.enabled,
         updated_at = unixepoch()`,
    )
    .run({ tokenId, ...input, enabled: input.enabled ? 1 : 0 });
}

/** Turns a saved limit on or off without touching its amounts. Returns false if the token has no saved limit. */
export function setLimitEnabled(tokenId: number, enabled: boolean): boolean {
  return (
    getDb()
      .prepare("UPDATE spend_limits SET enabled = ?, updated_at = unixepoch() WHERE token_id = ?")
      .run(enabled ? 1 : 0, tokenId).changes > 0
  );
}

export function deleteLimit(tokenId: number): void {
  getDb().prepare("DELETE FROM spend_limits WHERE token_id = ?").run(tokenId);
}
