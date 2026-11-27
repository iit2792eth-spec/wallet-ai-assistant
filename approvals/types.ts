// Shared by server and browser. Keep free of server-only imports.

/**
 * Where a recipient came from. user: typed by the user. contact: a saved contact.
 * external: a web page or PDF. untrusted: anything else, such as an address read
 * from history or computed by the program. Only user and contact can be auto-approved.
 */
export type Provenance = "user" | "contact" | "external" | "untrusted";

export type ApprovalWarning = { code: string; message: string };

export type TransferItem = {
  symbol: string;
  decimals: number;
  /** Integer string in the token's smallest unit. */
  amount: string;
  to: string;
  toLabel?: string;
  provenance: Provenance;
};

type ApprovalBase = {
  id: string;
  sessionId: string;
  network: string;
  signer?: string;
  warnings: ApprovalWarning[];
  createdAt: number;
  expiresAt: number;
};

export type TransferApproval = ApprovalBase & {
  kind: "transfer";
  transfers: TransferItem[];
  estimatedFeeWei?: string;
};

export type TypedDataApproval = ApprovalBase & {
  kind: "typed_data";
  primaryType: string;
  /** Set when the type is one we recognise, e.g. "Permit". */
  knownType?: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
};

/** One step of a plan: a transfer or a typed-data signature, with whether it can be completed. */
export type PlanStep = (
  | {
      kind: "transfer";
      symbol: string;
      decimals: number;
      /** Integer string in the token's smallest unit. */
      amount: string;
      to: string;
      toLabel?: string;
      provenance: Provenance;
      /** Maximum network fee in wei, if estimated. */
      feeWei?: string;
      /** False if this step cannot be completed (see `note`). */
      runnable: boolean;
      note?: string;
    }
  | {
      kind: "typed_data";
      primaryType: string;
      knownType?: string;
      /** Plain-language summary for recognised types, e.g. a Permit. */
      summary?: string;
      domain: Record<string, unknown>;
      message: Record<string, unknown>;
      runnable: boolean;
      note?: string;
    }
  | {
      kind: "swap";
      symbolIn: string;
      symbolOut: string;
      decimalsIn: number;
      decimalsOut: number;
      side: "exact_in" | "exact_out";
      /** Integer strings in base units. amountIn/amountOut are the quote and the exact side; maxIn/minOut the limits. */
      amountIn: string;
      amountOut: string;
      maxIn: string;
      minOut: string;
      /** Pool fee tier, 100 = 0.01%. */
      feeTier?: number;
      priceImpactBps?: number;
      slippageBps: number;
      slippageSource: "settings" | "user";
      settingsSlippageBps: number;
      /** Maximum network fee in wei, if estimated. */
      feeWei?: string;
      runnable: boolean;
      note?: string;
    }
) & {
  /** Position across the whole plan, from 0. The card's "Step N" is index + 1. */
  index: number;
  /** A problem known before balances are considered; with `runnable`, lets the card recheck as rows are unticked. */
  problem?: string;
};

/** Which part of a long plan a card shows. Plans are reviewed in batches; see access/config.ts reviewBatchSize. */
export type PlanReview = {
  /** 1-based. */
  batch: number;
  batchCount: number;
  totalSteps: number;
  /** Balances (base units, per token symbol) left after the steps already approved in earlier batches. */
  balances: Record<string, string>;
  /** True if batches already approved will still be sent when this card is cancelled. */
  earlierApproved: boolean;
};

/**
 * Every action a program will take, checked together before anything runs.
 * If only the first `runnableCount` steps can be completed, approving runs just those.
 */
export type PlanApproval = ApprovalBase & {
  kind: "plan";
  steps: PlanStep[];
  runnableCount: number;
  /** Sum of the runnable steps' maximum network fees, in wei. */
  estimatedFeeWei?: string;
  /** Present when steps can be selected one by one (always, in sign mode). */
  review?: PlanReview;
};

/** A flagged sentence as shown to the user: display text only (secrets masked, long text cut). */
export type FlaggedSentence = { text: string; score: number };

/**
 * A web page, PDF or pasted message in which the injection classifier flagged
 * one or more sentences as possible injected instructions. The card shows the
 * counts, and the flagged sentences on request ("View flagged sentences"), as
 * plain text. The user chooses what to do with the source as a whole:
 *   approved          — remove the flagged sentences and continue;
 *   keep              — continue with them kept (the flag may be a false positive);
 *   rejected / expired — stop the request.
 */
export type InjectionReviewApproval = Omit<ApprovalBase, "network" | "signer"> & {
  kind: "injection_review";
  source: { kind: "web" | "pdf" | "pasted"; ref?: string };
  sentenceCount: number;
  flaggedCount: number;
  /** The highest-scoring flagged sentences, highest first, at most MAX_SHOWN_FLAGGED. */
  flagged: FlaggedSentence[];
  threshold: number;
};

/**
 * Asked before the plan's own card when the user typed a slippage above their
 * Settings value for one or more swaps: "are you sure?". Rejecting cancels the request.
 */
export type SlippageConfirmApproval = Omit<ApprovalBase, "network" | "signer"> & {
  kind: "slippage_confirm";
  swaps: {
    index: number;
    symbolIn: string;
    symbolOut: string;
    requestedBps: number;
    settingsBps: number;
    /** Plain-language consequence, e.g. "You could receive as little as 470.1 USDC (quote 497.1)." */
    effect: string;
  }[];
};

/** Requests that show a transfer or signature (everything but an injection review or a slippage check). */
export type SigningApprovalRequest = TransferApproval | TypedDataApproval | PlanApproval;

export type ApprovalRequest = SigningApprovalRequest | InjectionReviewApproval | SlippageConfirmApproval;

/**
 * approved / rejected / expired apply to every approval. `keep` is used only by
 * an injection review: the user continues with the flagged content left in.
 */
export type ApprovalDecision = "approved" | "rejected" | "expired" | "keep";

/** A decision plus, for a plan card, the step indexes the user left ticked (absent = all of them). */
export type ApprovalOutcome = { decision: ApprovalDecision; selected?: number[] };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a caller supplies; id and timestamps are assigned by the registry. */
export type ApprovalInput = DistributiveOmit<ApprovalRequest, "id" | "createdAt" | "expiresAt">;
