import { getDb } from "./index";
import { getSetting } from "./settings";

export type Network = {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string | null;
  nativeSymbol: string;
};

export function getActiveNetwork(): Network {
  const chainId = Number(getSetting("active_chain_id"));
  const row = getDb()
    .prepare(
      `SELECT chain_id AS chainId, name, rpc_url AS rpcUrl,
              explorer_url AS explorerUrl, native_symbol AS nativeSymbol
       FROM networks WHERE chain_id = ?`,
    )
    .get(chainId) as Network | undefined;
  if (!row) throw new Error(`Active network ${chainId} is not configured`);
  return row;
}

export function setRpcUrl(chainId: number, rpcUrl: string): void {
  getDb().prepare("UPDATE networks SET rpc_url = ? WHERE chain_id = ?").run(rpcUrl, chainId);
}
