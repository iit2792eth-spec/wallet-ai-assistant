import { custom, encodeAbiParameters, type EIP1193RequestFn } from "viem";
import { setTransportFactoryForTests } from "@/wallet/clients";

// A fake JSON-RPC node for tests: no request leaves the machine. Records every
// call so tests can check what was (and was not) sent.

export const TX_HASH = `0x${"ab".repeat(32)}` as const;

export type RpcCall = { method: string; params: unknown[] };
type Handler = (params: unknown[], call: number) => unknown;

export const rpcError = (message: string) => () => {
  throw Object.assign(new Error(message), { code: -32000 });
};

const receipt = (status: "0x1" | "0x0", hash: string) => ({
  status, blockNumber: "0x11", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00",
  transactionHash: hash, blockHash: TX_HASH, transactionIndex: "0x0",
  from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  cumulativeGasUsed: "0x5208", logs: [], logsBloom: `0x${"0".repeat(512)}`, type: "0x2", contractAddress: null,
});

export function fakeRpc(overrides: Record<string, Handler> = {}) {
  const calls: RpcCall[] = [];
  const counts = new Map<string, number>();
  let sent = 0;
  const defaults: Record<string, Handler> = {
    eth_chainId: () => "0xaa36a7",
    eth_blockNumber: () => "0x10",
    eth_getBalance: () => "0x4563918244f40000", // 5 ETH
    eth_call: (params) => {
      const data = ((params[0] as { data?: string; input?: string }).data ?? (params[0] as { input?: string }).input ?? "").slice(0, 10);
      if (data === "0x06fdde03") return encodeAbiParameters([{ type: "string" }], ["USDC"]); // name()
      if (data === "0x54fd4d50") return encodeAbiParameters([{ type: "string" }], ["2"]); // version()
      if (data === "0x7ecebe00") return encodeAbiParameters([{ type: "uint256" }], [BigInt(3)]); // nonces(owner)
      return `0x${(25_000_000).toString(16).padStart(64, "0")}`; // balanceOf: 25 USDC
    },
    eth_getTransactionCount: () => "0x0",
    eth_estimateGas: () => "0x5208",
    eth_maxPriorityFeePerGas: () => "0x3b9aca00",
    eth_gasPrice: () => "0x3b9aca00",
    eth_getBlockByNumber: () => ({ number: "0x10", baseFeePerGas: "0x3b9aca00", hash: TX_HASH, timestamp: "0x1", transactions: [] }),
    // Each sent transaction gets its own hash, so the actions table's unique tx_hash holds.
    eth_sendRawTransaction: () => `0x${(++sent).toString(16).padStart(64, "0")}`,
    eth_getTransactionReceipt: (params) => receipt("0x1", params[0] as string),
  };
  const handlers = { ...defaults, ...overrides };
  const request = (async ({ method, params }: { method: string; params?: unknown[] }) => {
    const n = (counts.get(method) ?? 0) + 1;
    counts.set(method, n);
    calls.push({ method, params: params ?? [] });
    const handler = handlers[method];
    if (!handler) throw new Error(`fake RPC: no handler for ${method}`);
    return handler(params ?? [], n);
  }) as EIP1193RequestFn;
  setTransportFactoryForTests(() => custom({ request }, { retryCount: 0 }));
  return {
    calls,
    count: (method: string) => counts.get(method) ?? 0,
    receipt,
  };
}
