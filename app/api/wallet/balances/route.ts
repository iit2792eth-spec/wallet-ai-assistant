import { connection } from "next/server";
import { getDb } from "@/db";
import { getActiveNetwork } from "@/db/networks";
import type { TokenBalance } from "@/lib/wallet-types";
import { WalletError, getBalance, type Token } from "@/wallet";

// The user's own balances, read live from the chain. Reading your own balance
// needs a wallet to exist but not to be unlocked.
export async function GET() {
  await connection();
  const tokens = getDb()
    .prepare("SELECT symbol FROM tokens WHERE chain_id = ? ORDER BY id")
    .all(getActiveNetwork().chainId) as { symbol: Token }[];

  const balances: TokenBalance[] = await Promise.all(
    tokens.map(async ({ symbol }) => {
      try {
        return { token: symbol, formatted: (await getBalance({ token: symbol })).formatted };
      } catch (error) {
        return { token: symbol, error: error instanceof WalletError ? error.message : "Could not read the balance." };
      }
    }),
  );
  return Response.json(balances);
}
