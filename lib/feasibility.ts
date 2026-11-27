// Which steps of a plan can be completed, given the starting balances and the
// steps the user left out. Shared by the access layer and the approval card, so
// the card's live "Will not run" marks follow exactly the rules the server
// applies when it decides what to send. Pure: no I/O, no server imports.
//
// Rules:
// - Steps run in order. A step that cannot be completed stops every later step
//   (later steps may depend on earlier ones), unless the user leaves it out.
// - A left-out step costs nothing and blocks nothing.
// - A transfer needs its amount plus, for ETH, its maximum fee; a token transfer
//   also needs its fee in ETH. Balances run down step by step.
// - A swap needs the most it may pay (plus its fee, in ETH), and adds only the
//   least it may receive to the token it buys, for the steps after it.

export type CostStep = {
  index: number;
  kind: "transfer" | "sign_typed_data" | "swap";
  /** Transfers only. */
  token?: string;
  decimals?: number;
  amount?: bigint;
  /** Maximum network fee in wei, if estimated. */
  feeWei?: bigint;
  /** A problem known before balances are considered (unknown recipient, unavailable token...). */
  problem?: string;
  /** Swaps only: what is bought and the least that arrives. `token`, `decimals` and `amount` are the side paid (amount = the most paid). */
  tokenOut?: string;
  minOut?: bigint;
};

export type StepVerdict = { index: number; state: "runnable" | "blocked" | "excluded"; note?: string };

export type Feasibility = {
  verdicts: StepVerdict[];
  /** Index of the first included step that cannot be completed, or null. */
  firstFailure: number | null;
  /** Balances after every included runnable step, in base units. */
  balancesAfter: Record<string, bigint>;
};

/** Decimal string of a base-unit amount, without trailing zeros. */
export function formatBase(amount: bigint, decimals: number): string {
  const negative = amount < BigInt(0);
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

const fmt = (amount: bigint, decimals: number, symbol: string) => `${formatBase(amount, decimals)} ${symbol}`;

/**
 * Assesses `steps` (in order) against `balances` (base units per token symbol),
 * leaving out the indexes in `excluded`. Step numbers in notes are index + 1.
 */
export function assessSteps(steps: CostStep[], excluded: ReadonlySet<number>, balances: Readonly<Record<string, bigint>>): Feasibility {
  const left: Record<string, bigint> = { ...balances };
  const zero = BigInt(0);
  const verdicts: StepVerdict[] = [];
  let firstFailure: number | null = null;

  for (const step of steps) {
    if (excluded.has(step.index)) {
      verdicts.push({ index: step.index, state: "excluded" });
      continue;
    }
    if (firstFailure !== null) {
      verdicts.push({ index: step.index, state: "blocked", note: `Not run, because step ${firstFailure + 1} cannot be completed.` });
      continue;
    }
    if (step.problem) {
      firstFailure = step.index;
      verdicts.push({ index: step.index, state: "blocked", note: step.problem });
      continue;
    }
    if ((step.kind !== "transfer" && step.kind !== "swap") || step.token === undefined || step.amount === undefined) {
      verdicts.push({ index: step.index, state: "runnable" });
      continue;
    }

    const token = step.token;
    const decimals = step.decimals ?? 18;
    const fee = step.feeWei ?? zero;
    const isEth = token === "ETH";
    const needed = step.amount + (isEth ? fee : zero);
    const tokenLeft = (left[token] ?? zero) - needed;
    if (tokenLeft < zero) {
      const had = tokenLeft + needed;
      firstFailure = step.index;
      verdicts.push({
        index: step.index,
        state: "blocked",
        note: `Not enough ${token}: this step needs ${fmt(needed, decimals, token)}${isEth && fee ? " including the fee" : ""}, and ${fmt(had > zero ? had : zero, decimals, token)} would be left by then.`,
      });
      continue;
    }
    if (!isEth && fee > zero) {
      const ethLeft = (left.ETH ?? zero) - fee;
      if (ethLeft < zero) {
        firstFailure = step.index;
        verdicts.push({ index: step.index, state: "blocked", note: `Not enough ETH for the network fee of this step (up to ${fmt(fee, 18, "ETH")}).` });
        continue;
      }
      left.ETH = ethLeft;
    }
    left[token] = tokenLeft;
    // A swap's output counts for later steps at its guaranteed minimum only.
    if (step.kind === "swap" && step.tokenOut !== undefined && step.minOut !== undefined) left[step.tokenOut] = (left[step.tokenOut] ?? zero) + step.minOut;
    verdicts.push({ index: step.index, state: "runnable" });
  }
  return { verdicts, firstFailure, balancesAfter: left };
}
