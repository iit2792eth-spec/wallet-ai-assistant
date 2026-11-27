import {
  erc20Abi,
  formatUnits,
  hashTypedData,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from "viem";
import { normalize } from "viem/ens";
import { getDb } from "@/db";
import type { Network } from "@/db/networks";
import { activeNetwork, ensClient, publicClientFor, walletClientFor } from "./clients";
import { WalletError, toWalletError } from "./errors";
import { requireUnlockedAccount, walletAddress } from "./keystore";
import { errorSummary, shortAddress, shortHash, walletLog } from "./log";

// The wallet layer. One function per task, called only by the access layer:
//
//   getBalance      read a token balance
//   resolveEns      ENS name -> address
//   lookupEns       address -> ENS name
//   estimateTransfer  gas and fee a transfer would cost, without sending it
//   transfer        send ETH or an ERC-20 token, and wait for the result
//   pendingNonce / submitTransfer / waitForTransfer
//                   the same in two halves, so a batch can be sent without
//                   waiting for each transaction before sending the next
//   getPermitData   what an EIP-2612 permit for a token must contain (name, version, nonce)
//   signTypedData   sign EIP-712 typed data off-chain
//   getActivity     transfers and signatures made through this app
//
// Keystore management (create, import, unlock, lock, remove, status) is in ./keystore.
//
// This layer does no checks: it assumes the access layer has validated every
// input and obtained the user's approval. It does what it is asked, and on any
// failure throws a WalletError with a code and a message safe to show the user.

export { WalletError, type WalletErrorCode } from "./errors";
export {
  FEE_TIERS, buildSwapCall, dexContracts, estimateSwap, feeRates, priceImpactBps, quoteSwap, sendSwap, signSwapPermit,
  type SwapCall, type SwapGas, type SwapPermit, type SwapQuote, type SwapResult, type SwapSide,
} from "./uniswap";
export { createWallet, getWalletStatus, importWallet, lockWallet, removeWallet, unlockWallet, type WalletStatus } from "./keystore";

/** Tokens the wallet can move. Amounts in WEI or GWEI are ETH amounts: convert to wei before calling. */
export type Token = "ETH" | "USDC" | "EURC";

type TokenInfo = { symbol: Token; address: Address | null; decimals: number };

/** A token's contract address and decimals on the network, from the `tokens` table. Null address = the native coin. */
function tokenInfo(network: Network, token: Token): TokenInfo {
  const row = getDb()
    .prepare("SELECT symbol, address, decimals FROM tokens WHERE chain_id = ? AND symbol = ? COLLATE NOCASE")
    .get(network.chainId, token) as { symbol: string; address: string | null; decimals: number } | undefined;
  if (!row) throw new WalletError("TOKEN_NOT_CONFIGURED");
  return { symbol: token, address: row.address as Address | null, decimals: row.decimals };
}

const explorerTxUrl = (network: Network, hash: Hex) => (network.explorerUrl ? `${network.explorerUrl}/tx/${hash}` : null);

/** Runs a task, logging its outcome and converting any failure into a WalletError. */
async function task<T>(name: string, detail: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    walletLog(`${name}_ok`, { ...detail, ms: Date.now() - started });
    return result;
  } catch (error) {
    const walletError = toWalletError(error);
    walletLog(`${name}_failed`, { ...detail, ms: Date.now() - started, code: walletError.code, ...errorSummary(error) });
    throw walletError;
  }
}

// ---------------------------------------------------------------------------
// getBalance
// ---------------------------------------------------------------------------

export type GetBalanceInput = {
  token: Token;
  /** Whose balance. Omit for the user's own wallet (needs a wallet to exist, not to be unlocked). */
  address?: Address;
};

export type BalanceResult = {
  token: Token;
  address: Address;
  /** Base units (wei for ETH, 6 decimals for USDC and EURC). */
  amount: bigint;
  decimals: number;
  /** Decimal string for display, e.g. "0.25". */
  formatted: string;
  chainId: number;
  network: string;
  blockNumber: bigint;
};

/**
 * Reads the balance of `token` for `address` (default: the user's wallet) on the active network.
 * Throws WALLET_NOT_FOUND (no address and no wallet), TOKEN_NOT_CONFIGURED, RPC_UNAVAILABLE, RPC_ERROR.
 */
export async function getBalance(input: GetBalanceInput): Promise<BalanceResult> {
  return task("get_balance", { token: input.token, address: input.address ? shortAddress(input.address) : "own" }, async () => {
    const network = activeNetwork();
    const info = tokenInfo(network, input.token);
    const address = input.address ?? (await walletAddress());
    const client = publicClientFor(network);
    const blockNumber = await client.getBlockNumber();
    const amount = info.address
      ? await client.readContract({ address: info.address, abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber })
      : await client.getBalance({ address, blockNumber });
    return {
      token: input.token,
      address,
      amount,
      decimals: info.decimals,
      formatted: formatUnits(amount, info.decimals),
      chainId: network.chainId,
      network: network.name,
      blockNumber,
    };
  });
}

// ---------------------------------------------------------------------------
// resolveEns / lookupEns (Ethereum mainnet ENS)
// ---------------------------------------------------------------------------

export type ResolveEnsResult = {
  name: string;
  /** The address the name points to, or null if it has none. */
  address: Address | null;
};

/**
 * Forward lookup: the address an ENS name (e.g. "vitalik.eth") points to, read from Ethereum mainnet.
 * Throws RPC_UNAVAILABLE, RPC_ERROR.
 */
export async function resolveEns(input: { name: string }): Promise<ResolveEnsResult> {
  return task("resolve_ens", {}, async () => {
    const name = normalize(input.name);
    const address = await ensClient().getEnsAddress({ name });
    return { name, address: address ?? null };
  });
}

export type LookupEnsResult = {
  address: Address;
  /** The address's primary ENS name, or null if it has none. */
  name: string | null;
};

/**
 * Reverse lookup: the primary ENS name of an address, read from Ethereum mainnet.
 * The name is only returned if it also resolves back to the same address.
 * Throws RPC_UNAVAILABLE, RPC_ERROR.
 */
export async function lookupEns(input: { address: Address }): Promise<LookupEnsResult> {
  return task("lookup_ens", { address: shortAddress(input.address) }, async () => {
    const name = await ensClient().getEnsName({ address: input.address });
    return { address: input.address, name: name ?? null };
  });
}

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

export type TransferInput = {
  token: Token;
  /** Recipient address. ENS names must be resolved by the access layer first. */
  to: Address;
  /** Base units (wei for ETH). */
  amount: bigint;
  /** How long to wait for the transaction to be mined. Default 120 seconds. */
  waitMs?: number;
  /**
   * Gas and fee caps to send with, usually from estimateTransfer. With them the
   * fee can never exceed gas * maxFeePerGas, so an amount computed as
   * "balance minus that fee" is always affordable. Omit to let the node decide.
   */
  fees?: TransferFees;
};

export type TransferFees = { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

export type TransferResult = {
  /** confirmed: mined and succeeded. reverted: mined but failed (fee still paid). pending: sent, not mined within waitMs. */
  status: "confirmed" | "reverted" | "pending";
  hash: Hex;
  from: Address;
  to: Address;
  token: Token;
  amount: bigint;
  /** Decimal string for display, e.g. "0.01". */
  formatted: string;
  chainId: number;
  network: string;
  blockNumber: bigint | null;
  /** Fee paid in wei, once mined. */
  feeWei: bigint | null;
  explorerUrl: string | null;
};

export type SubmittedTransfer = Omit<TransferResult, "status" | "blockNumber" | "feeWei">;

/**
 * The next nonce of the user's wallet, counting transactions still in the
 * mempool. A batch takes it once and numbers its transactions from there, so
 * several can be sent before the first is mined. Throws WALLET_NOT_FOUND, RPC_UNAVAILABLE, RPC_ERROR.
 */
export async function pendingNonce(): Promise<number> {
  return task("pending_nonce", {}, async () => {
    const network = activeNetwork();
    return publicClientFor(network).getTransactionCount({ address: await walletAddress(), blockTag: "pending" });
  });
}

/**
 * Signs and sends a transfer without waiting for it to be mined. `nonce` is
 * optional: give it when sending several in a row (see pendingNonce).
 * Throws as transfer() does, except that nothing is waited for.
 */
export async function submitTransfer(input: Omit<TransferInput, "waitMs"> & { nonce?: number }): Promise<SubmittedTransfer> {
  const detail = { token: input.token, to: shortAddress(input.to), amount: input.amount.toString(), ...(input.nonce !== undefined ? { nonce: input.nonce } : {}) };
  return task("transfer_submit", detail, async () => {
    const network = activeNetwork();
    const info = tokenInfo(network, input.token);
    const account = requireUnlockedAccount();
    const walletClient = walletClientFor(network, account);
    const extra = { ...input.fees, ...(input.nonce !== undefined ? { nonce: input.nonce } : {}) };

    const hash = info.address
      ? await walletClient.writeContract({ address: info.address, abi: erc20Abi, functionName: "transfer", args: [input.to, input.amount], ...extra })
      : await walletClient.sendTransaction({ to: input.to, value: input.amount, ...extra });
    walletLog("transfer_sent", { ...detail, tx: shortHash(hash) });
    return {
      hash,
      from: account.address,
      to: input.to,
      token: input.token,
      amount: input.amount,
      formatted: formatUnits(input.amount, info.decimals),
      chainId: network.chainId,
      network: network.name,
      explorerUrl: explorerTxUrl(network, hash),
    };
  });
}

/**
 * Waits up to `waitMs` (default 120 s) for a submitted transfer to be mined.
 * Returns status "pending" if it is not mined in time. Throws RPC_UNAVAILABLE, RPC_ERROR.
 */
export async function waitForTransfer(sent: SubmittedTransfer, waitMs = 120_000): Promise<TransferResult> {
  return task("transfer_wait", { tx: shortHash(sent.hash) }, async () => {
    try {
      const receipt = await publicClientFor(activeNetwork()).waitForTransactionReceipt({ hash: sent.hash, timeout: waitMs });
      return {
        ...sent,
        status: receipt.status === "success" ? "confirmed" : "reverted",
        blockNumber: receipt.blockNumber,
        feeWei: receipt.gasUsed * receipt.effectiveGasPrice,
      };
    } catch (error) {
      // Sent but not mined in time: not a failure, the caller can check the hash later.
      if (error instanceof WaitForTransactionReceiptTimeoutError) return { ...sent, status: "pending", blockNumber: null, feeWei: null };
      throw error;
    }
  });
}

/**
 * Signs and sends a transfer of `amount` (base units) of `token` to `to` on the
 * active network, then waits up to `waitMs` for it to be mined. Gas and nonce
 * are set automatically. No checks: the access layer has validated and approved it.
 * Throws WALLET_NOT_FOUND, WALLET_LOCKED, TOKEN_NOT_CONFIGURED, INSUFFICIENT_FUNDS,
 * TRANSFER_REVERTED (rejected when estimated), NONCE_CONFLICT, FEE_TOO_LOW, RPC_UNAVAILABLE, RPC_ERROR.
 * A transaction that is sent and then fails on chain is returned with status "reverted", not thrown.
 */
export async function transfer(input: TransferInput): Promise<TransferResult> {
  return waitForTransfer(await submitTransfer(input), input.waitMs);
}

// ---------------------------------------------------------------------------
// estimateTransfer
// ---------------------------------------------------------------------------

export type EstimateTransferInput = {
  token: Token;
  /** Recipient address. */
  to: Address;
  /** Base units (wei for ETH). */
  amount: bigint;
};

export type EstimateTransferResult = {
  gas: bigint;
  /** Worst-case fee per gas the transfer would be sent with. */
  maxFeePerGas: bigint;
  /** Tip per gas for the validator. */
  maxPriorityFeePerGas: bigint;
  /** gas * maxFeePerGas: the most the network fee can be. */
  maxFeeWei: bigint;
};

/**
 * Estimates the gas and the maximum network fee for a transfer from the user's
 * wallet, against the current chain state. Sends nothing and needs no unlock.
 * Throws WALLET_NOT_FOUND, TOKEN_NOT_CONFIGURED, INSUFFICIENT_FUNDS (the node
 * says the wallet cannot cover it), TRANSFER_REVERTED (the token contract would
 * refuse it), RPC_UNAVAILABLE, RPC_ERROR.
 */
/** The intrinsic gas of a plain value transfer. A real transfer never costs less. */
const MIN_TRANSFER_GAS = BigInt(21_000);

/** Plain ETH to a contract that has no way to receive it reverts; the token-contract wording would mislead. */
const ETH_REFUSED =
  "The recipient refused this ETH transfer: it is a contract that does not accept ETH sent this way, so the transaction would fail.";

export async function estimateTransfer(input: EstimateTransferInput): Promise<EstimateTransferResult> {
  const detail = { token: input.token, to: shortAddress(input.to), amount: input.amount.toString() };
  return task("estimate_transfer", detail, () => estimate(input).catch((error) => {
    const walletError = toWalletError(error);
    if (input.token === "ETH" && walletError.code === "TRANSFER_REVERTED") throw new WalletError("TRANSFER_REVERTED", { cause: error, message: ETH_REFUSED });
    throw walletError;
  }));
}

async function estimate(input: EstimateTransferInput): Promise<EstimateTransferResult> {
  const network = activeNetwork();
  const info = tokenInfo(network, input.token);
  const from = await walletAddress();
  const client = publicClientFor(network);
  const [estimated, fees] = await Promise.all([
    info.address
      ? client.estimateContractGas({ address: info.address, abi: erc20Abi, functionName: "transfer", args: [input.to, input.amount], account: from })
      : client.estimateGas({ account: from, to: input.to, value: input.amount }),
    client.estimateFeesPerGas(),
  ]);
  // Never send below the intrinsic minimum. Some nodes return a lower estimate
  // for a zero-value probe than the 21,000 a real transfer actually needs,
  // which would be rejected on broadcast as "intrinsic gas too low".
  const gas = estimated < MIN_TRANSFER_GAS ? MIN_TRANSFER_GAS : estimated;
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? BigInt(0);
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? maxFeePerGas;
  return { gas, maxFeePerGas, maxPriorityFeePerGas, maxFeeWei: gas * maxFeePerGas };
}

// ---------------------------------------------------------------------------
// getPermitData (EIP-2612)
// ---------------------------------------------------------------------------

const permitAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export type PermitData = {
  /** EIP-712 domain fields, read from the token contract. */
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
  /** The user's address, which signs the permit. */
  owner: Address;
  /** The token's next permit nonce for the owner. */
  nonce: bigint;
};

/**
 * Reads what an EIP-2612 permit for `token` must contain: the token's EIP-712
 * name and version, its contract address, and the wallet's next nonce.
 * Needs a wallet, not an unlock. Throws WALLET_NOT_FOUND, TOKEN_NOT_CONFIGURED
 * (including ETH, which is not a contract), PERMIT_NOT_SUPPORTED, RPC_UNAVAILABLE, RPC_ERROR.
 */
export async function getPermitData(input: { token: Token }): Promise<PermitData> {
  return task("get_permit_data", { token: input.token }, async () => {
    const network = activeNetwork();
    const info = tokenInfo(network, input.token);
    if (!info.address) throw new WalletError("TOKEN_NOT_CONFIGURED");
    const owner = await walletAddress();
    const client = publicClientFor(network);
    const read = <N extends "name" | "version" | "nonces">(functionName: N, args?: readonly [Address]) =>
      client.readContract({ address: info.address!, abi: permitAbi, functionName, args } as never) as Promise<N extends "nonces" ? bigint : string>;

    let name: string;
    let nonce: bigint;
    try {
      [name, nonce] = await Promise.all([read("name"), read("nonces", [owner])]);
    } catch (error) {
      const walletError = toWalletError(error);
      throw walletError.code === "RPC_UNAVAILABLE" ? walletError : new WalletError("PERMIT_NOT_SUPPORTED", { cause: error });
    }
    // Most EIP-2612 tokens expose version(); those that do not use "1".
    const version = await read("version").catch(() => "1");
    return { name, version, chainId: network.chainId, verifyingContract: info.address, owner, nonce };
  });
}

// ---------------------------------------------------------------------------
// signTypedData (EIP-712, off-chain)
// ---------------------------------------------------------------------------

export type SignTypedDataInput = {
  /** A complete EIP-712 object: domain, types, primaryType, message. */
  typedData: TypedDataDefinition;
};

export type SignTypedDataResult = {
  signature: Hex;
  /** The EIP-712 digest that was signed. */
  digest: Hex;
  signer: Address;
  primaryType: string;
};

/**
 * Signs EIP-712 typed data with the wallet's key. Nothing is sent to the network.
 * No checks: the access layer has validated the data and the user has approved it.
 * Throws WALLET_NOT_FOUND, WALLET_LOCKED, UNKNOWN (typed data that cannot be encoded).
 */
export async function signTypedData(input: SignTypedDataInput): Promise<SignTypedDataResult> {
  const primaryType = String(input.typedData.primaryType);
  return task("sign_typed_data", { primaryType }, async () => {
    const account = requireUnlockedAccount();
    const digest = hashTypedData(input.typedData);
    const signature = await account.signTypedData(input.typedData);
    // The signature is never logged: a signed permit can be replayed by anyone who reads it.
    walletLog("signed", { primaryType, digest: shortHash(digest) });
    return { signature, digest, signer: account.address, primaryType };
  });
}

// ---------------------------------------------------------------------------
// getActivity (this app's own record, from SQLite)
// ---------------------------------------------------------------------------

export type GetActivityInput = {
  /** Newest first; default 20, at most 200. */
  limit?: number;
  /** "transfer" for transfers only, "sign_typed_data" for signatures only. Default: both. */
  kind?: "transfer" | "sign_typed_data";
};

export type ActivityEntry = {
  id: number;
  kind: "transfer" | "sign_typed_data" | "swap";
  status: string;
  /** Unix seconds. */
  timestamp: number;
  chainId: number;
  // Transfers
  to: Address | null;
  toLabel: string | null;
  token: Token | null;
  /** Base units. */
  amount: bigint | null;
  formatted: string | null;
  /** Network fee paid, in wei, once mined. */
  feeWei: bigint | null;
  txHash: Hex | null;
  // Signatures
  primaryType: string | null;
};

/**
 * Transfers and signatures made through this app, newest first, from the local
 * `actions` table. Incoming and external transactions are not included.
 * Throws UNKNOWN if the database cannot be read.
 */
export async function getActivity(input: GetActivityInput = {}): Promise<ActivityEntry[]> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 200);
  return task("get_activity", { limit, kind: input.kind ?? "all" }, async () => {
    const rows = getDb()
      .prepare(
        `SELECT a.id, a.kind, a.status, a.created_at AS timestamp, a.chain_id AS chainId,
                a.to_address AS "to", a.to_label AS toLabel, t.symbol AS token, t.decimals,
                a.amount, a.fee_wei AS feeWei, a.tx_hash AS txHash, a.td_primary_type AS primaryType
         FROM actions a LEFT JOIN tokens t ON t.id = a.token_id
         WHERE (@kind IS NULL OR a.kind = @kind)
         ORDER BY a.created_at DESC, a.id DESC LIMIT @limit`,
      )
      .all({ kind: input.kind ?? null, limit }) as (Omit<ActivityEntry, "amount" | "formatted" | "feeWei"> & {
      amount: string | null;
      feeWei: string | null;
      decimals: number | null;
    })[];
    return rows.map(({ decimals, amount, feeWei, ...row }) => ({
      ...row,
      feeWei: feeWei === null ? null : BigInt(feeWei),
      amount: amount === null ? null : BigInt(amount),
      formatted: amount === null || decimals === null ? null : formatUnits(BigInt(amount), decimals),
    }));
  });
}
