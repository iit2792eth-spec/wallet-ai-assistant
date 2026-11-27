import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { formatUnits, getAddress, hashTypedData, isAddress, validateTypedData, type TypedDataDefinition } from "viem";
import { getDb } from "@/db";
import type { PermitData } from "@/wallet";
import { shortAddress } from "@/lib/logger";
import { LIMITS } from "./config";
import { AccessError, PlanBlocked } from "./types";

// EIP-712 typed data: load it, check it, and describe it in plain language.
// A message for another chain or another signer blocks the plan: signing it
// could authorise something the user cannot see on this network.

const DATA_DIR = path.join(process.cwd(), "data");
const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);
const SIGNER_FIELDS = ["owner", "from", "signer", "account", "holder"];
const PERMIT2_TYPES = new Set(["PermitSingle", "PermitBatch", "PermitTransferFrom", "PermitBatchTransferFrom", "PermitWitnessTransferFrom"]);

export type CheckedTypedData = {
  typedData: TypedDataDefinition;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
  digest: `0x${string}`;
  knownType?: string;
  summary?: string;
  warnings: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * Builds an EIP-2612 permit from the template's parameters. Domain, contract,
 * owner and nonce come from the chain and the wallet, never from the model.
 */
export function buildPermit(data: PermitData, spender: string, amount: bigint, deadline: bigint): Record<string, unknown> {
  return {
    domain: { name: data.name, version: data.version, chainId: data.chainId, verifyingContract: data.verifyingContract },
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: { owner: data.owner, spender, value: amount.toString(), nonce: data.nonce.toString(), deadline: deadline.toString() },
  };
}

/** Reads a typed-data JSON file the user named. Throws AccessError. */
export async function loadTypedDataFile(file: string): Promise<unknown> {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".json") {
    throw new AccessError("Give the full path of a .json file with the typed data.");
  }
  let real: string;
  try {
    real = await realpath(file);
  } catch {
    throw new AccessError("The typed-data file was not found.");
  }
  // The app's own files (database, keystore, logs) are never readable this way.
  if (real === DATA_DIR || real.startsWith(DATA_DIR + path.sep)) throw new AccessError("That file cannot be used.");
  if ((await stat(real)).size > LIMITS.maxTypedDataFileBytes) throw new AccessError("The typed-data file is too large.");
  try {
    return JSON.parse(await readFile(/*turbopackIgnore: true*/ real, "utf8"));
  } catch {
    throw new AccessError("The typed-data file is not valid JSON.");
  }
}

function asBigInt(value: unknown): bigint | null {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
    if (typeof value === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return BigInt(value);
  } catch {}
  return null;
}

function tokenFor(chainId: number, contract: unknown): { symbol: string; decimals: number } | undefined {
  if (typeof contract !== "string") return undefined;
  return getDb()
    .prepare("SELECT symbol, decimals FROM tokens WHERE chain_id = ? AND address = ? COLLATE NOCASE")
    .get(chainId, contract) as { symbol: string; decimals: number } | undefined;
}

const date = (seconds: bigint) =>
  seconds > BigInt(253402300799) ? "never (no expiry)" : new Date(Number(seconds) * 1000).toUTCString();

/**
 * Validates typed data and checks it against the active chain and the wallet.
 * Throws AccessError for data that is not valid EIP-712 (that step cannot run)
 * and PlanBlocked for a chain or signer mismatch (the whole plan stops).
 */
export function checkTypedData(raw: unknown, chainId: number, wallet: string | null): CheckedTypedData {
  if (!isRecord(raw) || !isRecord(raw.domain) || !isRecord(raw.types) || typeof raw.primaryType !== "string" || !isRecord(raw.message)) {
    throw new AccessError("Not valid EIP-712 typed data: it needs domain, types, primaryType and message.");
  }
  const typedData = raw as unknown as TypedDataDefinition;
  let digest: `0x${string}`;
  try {
    validateTypedData(typedData);
    digest = hashTypedData(typedData);
  } catch (error) {
    throw new AccessError(`Not valid EIP-712 typed data: ${(error as Error).message.split("\n")[0].slice(0, 160)}`);
  }

  const domain = raw.domain;
  const message = raw.message;
  const primaryType = raw.primaryType;
  const warnings: string[] = [];

  const domainChain = asBigInt(domain.chainId);
  if (domainChain === null) warnings.push("The message does not name a chain, so it could be used on other networks.");
  else if (domainChain !== BigInt(chainId)) {
    throw new PlanBlocked(`The message is for chain ${domainChain}, but the wallet is on chain ${chainId}.`);
  }

  if (wallet) {
    for (const field of SIGNER_FIELDS) {
      const value = message[field];
      if (typeof value === "string" && isAddress(value, { strict: false }) && value.toLowerCase() !== wallet.toLowerCase()) {
        throw new PlanBlocked(`The message's ${field} is ${shortAddress(getAddress(value))}, not your wallet.`);
      }
    }
  }

  let knownType: string | undefined;
  let summary: string | undefined;
  if (primaryType === "Permit" && ["owner", "spender", "value", "deadline"].every((key) => key in message)) {
    knownType = "Permit (EIP-2612)";
    const value = asBigInt(message.value);
    const token = tokenFor(chainId, domain.verifyingContract);
    const amount =
      value === null ? String(message.value)
        : value === MAX_UINT256 ? "an unlimited amount"
          : token ? `${formatUnits(value, token.decimals)} ${token.symbol}` : `${value} base units of ${String(domain.name ?? "the token")}`;
    const deadline = asBigInt(message.deadline);
    const spender = typeof message.spender === "string" && isAddress(message.spender, { strict: false }) ? shortAddress(getAddress(message.spender)) : String(message.spender);
    summary = `Lets ${spender} spend ${amount} of your tokens${deadline === null ? "" : `, until ${date(deadline)}`}.`;
    if (value === MAX_UINT256) warnings.push("This permit allows an unlimited amount.");
  } else if (domain.name === "Permit2" && PERMIT2_TYPES.has(primaryType)) {
    knownType = "Permit2";
    const spender = typeof message.spender === "string" && isAddress(message.spender, { strict: false }) ? shortAddress(getAddress(message.spender)) : "a spender";
    summary = `A Permit2 approval (${primaryType}) that lets ${spender} move your tokens.`;
  } else {
    warnings.push("Unknown message type. Check every field before approving.");
  }

  return { typedData, primaryType, domain, message, digest, knownType, summary, warnings };
}
