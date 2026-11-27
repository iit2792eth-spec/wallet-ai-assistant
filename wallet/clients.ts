import { createPublicClient, createWalletClient, defineChain, http, type Chain, type PublicClient, type Transport } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";
import { getActiveNetwork, type Network } from "@/db/networks";
import { getSetting } from "@/db/settings";
import { httpsOnlyRefusal } from "@/lib/https-only";
import { WalletError } from "./errors";

// viem clients for the active network (from the database) and for ENS, which
// lives on Ethereum mainnet. Reads only: ENS lookups need no funds.

const KNOWN_CHAINS: Record<number, Chain> = { [sepolia.id]: sepolia, [mainnet.id]: mainnet };
const DEFAULT_ENS_RPC = "https://ethereum-rpc.publicnode.com";
const RPC_TIMEOUT_MS = 20_000;

/** Tests can replace the transport so no request leaves the machine. */
type TransportFactory = (url: string) => Transport;
let makeTransport: TransportFactory = (url) => http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 1 });
export function setTransportFactoryForTests(factory: TransportFactory | null): void {
  makeTransport = factory ?? ((url) => http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }));
}

function chainFor(network: Network): Chain {
  const known = KNOWN_CHAINS[network.chainId];
  const base =
    known ??
    defineChain({
      id: network.chainId,
      name: network.name,
      nativeCurrency: { name: network.nativeSymbol, symbol: network.nativeSymbol, decimals: 18 },
      rpcUrls: { default: { http: [network.rpcUrl] } },
    });
  return { ...base, rpcUrls: { default: { http: [network.rpcUrl] } } };
}

export function activeNetwork(): Network {
  try {
    return getActiveNetwork();
  } catch (error) {
    throw new WalletError("NETWORK_NOT_CONFIGURED", { cause: error });
  }
}

/**
 * HTTPS only (Settings): every RPC connection, reads and sends alike, goes
 * through one of the clients below, so an http RPC URL is refused here before
 * any request is made, with the reason.
 */
function rpcTransport(url: string, what: string): Transport {
  const refusal = httpsOnlyRefusal(url, what);
  if (refusal) throw new WalletError("HTTPS_REQUIRED", { message: refusal });
  return makeTransport(url);
}

export function publicClientFor(network: Network): PublicClient {
  return createPublicClient({ chain: chainFor(network), transport: rpcTransport(network.rpcUrl, `The ${network.name} RPC URL (${network.rpcUrl})`) });
}

export function walletClientFor(network: Network, account: PrivateKeyAccount) {
  return createWalletClient({ account, chain: chainFor(network), transport: rpcTransport(network.rpcUrl, `The ${network.name} RPC URL (${network.rpcUrl})`) });
}

/** Mainnet client used only for ENS. Its RPC URL is the `ens_rpc_url` setting. */
export function ensClient(): PublicClient {
  const url = getSetting("ens_rpc_url") || DEFAULT_ENS_RPC;
  return createPublicClient({ chain: mainnet, transport: rpcTransport(url, `The ENS RPC URL (${url})`) });
}
