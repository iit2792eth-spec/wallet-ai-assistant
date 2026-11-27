import type { Address, TypedDataDefinition } from "viem";
import type { Provenance } from "@/approvals/types";
import type { Token } from "@/wallet";

/** A refusal whose message is safe to show the user and to pass into the sandbox. */
export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessError";
  }
}

/** A problem that stops the whole plan: never offered as a partial approval. */
export class PlanBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanBlocked";
  }
}

/** An action as the program proposed it, after schema validation. */
export type ParsedAction =
  | { kind: "transfer"; token: Token; to: string; amount: bigint }
  | { kind: "sign_typed_data"; typedData?: unknown; file?: string; permit?: PermitParams }
  | SwapAction;

/**
 * A Uniswap swap as the program proposed it: what to pay, what to get, and
 * either the exact amount paid (amountIn) or the exact amount received
 * (amountOut). `slippageBps` only counts if the user wrote that figure.
 */
export type SwapAction = { kind: "swap"; tokenIn: Token; tokenOut: Token; side: "exact_in" | "exact_out"; amount: bigint; slippageBps?: number };

/** Parameters of the "permit" signing template (EIP-2612). */
export type PermitParams = { token: Token; spender: string; amount: bigint; deadline?: number };

type StepBase = {
  /** Position across the whole program, from 0. */
  index: number;
  /** Which propose() call it came from, from 0. */
  batch: number;
  /** False if this step cannot be completed. */
  runnable: boolean;
  /** A problem known before balances are considered (unknown recipient, unavailable token, bad typed data...). */
  problem?: string;
  /** Why it cannot be completed, or other information. */
  note?: string;
};

export type TransferStep = StepBase & {
  kind: "transfer";
  token: Token;
  tokenId: number | null;
  decimals: number;
  amount: bigint;
  /** The recipient as the program wrote it: an address, ENS name or contact name. */
  input: string;
  /** Resolved address, or null if it could not be resolved. */
  to: Address | null;
  /** What the user sees: contact name or ENS name. */
  label?: string;
  provenance: Provenance;
  /** Maximum network fee in wei, once estimated. */
  feeWei?: bigint;
};

export type TypedDataStep = StepBase & {
  kind: "sign_typed_data";
  /** For a permit: who may spend, and where they came from. */
  spender?: { label?: string; provenance: Provenance };
  typedData: TypedDataDefinition | null;
  primaryType: string;
  knownType?: string;
  summary?: string;
  digest?: `0x${string}`;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
  warnings: string[];
};

export type SwapStep = StepBase & {
  kind: "swap";
  tokenIn: Token;
  tokenOut: Token;
  tokenInId: number | null;
  tokenOutId: number | null;
  decimalsIn: number;
  decimalsOut: number;
  side: "exact_in" | "exact_out";
  /** Exact for exact_in; the quote for exact_out. Base units. */
  amountIn: bigint;
  /** The quote for exact_in; exact for exact_out. Base units. */
  amountOut: bigint;
  /** The most that may be paid: amountIn for exact_in, the quote plus slippage for exact_out. */
  maxIn: bigint;
  /** The least accepted: the quote minus slippage for exact_in, amountOut for exact_out. */
  minOut: bigint;
  /** Pool fee tier (100 = 0.01%) and address; set once quoted. */
  feeTier?: number;
  pool?: string;
  priceImpactBps?: number;
  slippageBps: number;
  /** Where the slippage came from: the Settings value, or a figure the user typed for this request. */
  slippageSource: "settings" | "user";
  /** The Settings value, for the "are you sure" check when the user asked for more. */
  settingsSlippageBps: number;
  /** Maximum network fee in wei, once estimated (or worked out from a default gas limit). */
  feeWei?: bigint;
  /** Gas limit and fee rates to send with. */
  gas?: { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  /** Unix seconds after which the router refuses the swap. */
  deadline: number;
};

export type Step = TransferStep | TypedDataStep | SwapStep;

export type Analysis = {
  steps: Step[];
  /** Steps 0..runnableCount-1 can be completed. */
  runnableCount: number;
  /** Warnings for the approval card. */
  warnings: { code: string; message: string }[];
  /** True if the whole plan may run without asking (sign mode only). */
  autoApprove: boolean;
  /** Sum of the runnable steps' maximum fees, in wei. */
  totalFeeWei: bigint;
  /** Balances at the start, per token symbol, in base units: the basis of every feasibility check. */
  balances: Record<string, bigint>;
};
