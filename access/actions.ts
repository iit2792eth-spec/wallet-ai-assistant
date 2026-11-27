import type { Token } from "@/wallet";
import { LIMITS } from "./config";
import { parseToken } from "./host";
import { PlanBlocked, type ParsedAction, type PermitParams, type SwapAction } from "./types";

// Validates actions against the manifest's action schemas. A malformed action
// means the program is wrong, so it blocks the whole plan.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parsePermit(raw: Record<string, unknown>, where: string): PermitParams {
  if (raw.template !== "permit") throw new PlanBlocked(`${where} uses an unknown signing template; the only one is "permit".`);
  const params = raw.params;
  if (!isRecord(params)) throw new PlanBlocked(`${where} needs params for the permit.`);
  const extra = Object.keys(params).filter((key) => !["token", "spender", "amount", "deadline"].includes(key));
  if (extra.length) throw new PlanBlocked(`${where} has unknown permit params: ${extra.join(", ")}.`);
  let token: Token;
  try {
    token = parseToken(params.token, where);
  } catch (error) {
    throw new PlanBlocked((error as Error).message);
  }
  if (token === "ETH") throw new PlanBlocked(`${where}: ETH is not a token contract, so it cannot be permitted. Use USDC or EURC.`);
  if (typeof params.spender !== "string" || params.spender.trim() === "") throw new PlanBlocked(`${where} needs a spender.`);
  if (typeof params.amount !== "bigint" || params.amount <= BigInt(0)) throw new PlanBlocked(`${where} needs an amount greater than zero, in base units.`);
  if (params.deadline !== undefined && (typeof params.deadline !== "number" || !Number.isInteger(params.deadline) || params.deadline <= 0)) {
    throw new PlanBlocked(`${where} has an invalid deadline; give unix seconds.`);
  }
  return { token, spender: params.spender.trim(), amount: params.amount, deadline: params.deadline as number | undefined };
}

/** "1", "1.5", "1.5%" or 1.5 -> 150 basis points. */
function parseSlippage(value: unknown, where: string): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/%$/, "").trim() : "";
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new PlanBlocked(`${where} has an invalid slippage; give a percentage such as "1" or "1.5".`);
  const bps = Math.round(Number(text) * 100);
  if (bps <= 0 || bps >= 10_000) throw new PlanBlocked(`${where} has a slippage outside 0–100%.`);
  return bps;
}

function parseSwap(raw: Record<string, unknown>, where: string): SwapAction {
  const extra = Object.keys(raw).filter((key) => !["action", "tokenIn", "tokenOut", "amountIn", "amountOut", "slippage"].includes(key));
  if (extra.length) throw new PlanBlocked(`${where} has unknown fields: ${extra.join(", ")}.`);
  let tokenIn: Token;
  let tokenOut: Token;
  try {
    tokenIn = parseToken(raw.tokenIn, where);
    tokenOut = parseToken(raw.tokenOut, where);
  } catch (error) {
    throw new PlanBlocked((error as Error).message);
  }
  if (tokenIn === tokenOut) throw new PlanBlocked(`${where} swaps ${tokenIn} for itself.`);
  const given = [raw.amountIn !== undefined, raw.amountOut !== undefined].filter(Boolean).length;
  if (given !== 1) throw new PlanBlocked(`${where} needs exactly one of amountIn (the exact amount to pay) or amountOut (the exact amount to receive).`);
  const amount = raw.amountIn ?? raw.amountOut;
  if (typeof amount !== "bigint" || amount <= BigInt(0)) throw new PlanBlocked(`${where} needs an amount greater than zero, in base units.`);
  return {
    kind: "swap",
    tokenIn,
    tokenOut,
    side: raw.amountIn !== undefined ? "exact_in" : "exact_out",
    amount,
    ...(raw.slippage !== undefined ? { slippageBps: parseSlippage(raw.slippage, where) } : {}),
  };
}

function parseAction(raw: unknown, position: number): ParsedAction {
  const where = `Action ${position + 1}`;
  if (!isRecord(raw)) throw new PlanBlocked(`${where} is not an object.`);
  if (raw.action === "transfer") {
    const extra = Object.keys(raw).filter((key) => !["action", "to", "token", "amount"].includes(key));
    if (extra.length) throw new PlanBlocked(`${where} has unknown fields: ${extra.join(", ")}.`);
    if (typeof raw.to !== "string" || raw.to.trim() === "" || raw.to.length > 255) throw new PlanBlocked(`${where} has no valid recipient.`);
    if (typeof raw.amount !== "bigint" || raw.amount <= BigInt(0)) throw new PlanBlocked(`${where} needs an amount greater than zero, in base units.`);
    let token: Token;
    try {
      token = parseToken(raw.token, where);
    } catch (error) {
      throw new PlanBlocked((error as Error).message);
    }
    return { kind: "transfer", token, to: raw.to.trim(), amount: raw.amount };
  }
  if (raw.action === "swap") return parseSwap(raw, where);
  if (raw.action === "sign_typed_data") {
    const extra = Object.keys(raw).filter((key) => !["action", "typedData", "file", "template", "params"].includes(key));
    if (extra.length) throw new PlanBlocked(`${where} has unknown fields: ${extra.join(", ")}.`);
    const given = [raw.typedData !== undefined, raw.file !== undefined, raw.template !== undefined].filter(Boolean).length;
    if (given !== 1) throw new PlanBlocked(`${where} needs exactly one of template, typedData or file.`);
    if (raw.template !== undefined) return { kind: "sign_typed_data", permit: parsePermit(raw, where) };
    if (raw.params !== undefined) throw new PlanBlocked(`${where} has params without a template.`);
    if (raw.file !== undefined) {
      if (typeof raw.file !== "string") throw new PlanBlocked(`${where} has an invalid file path.`);
      return { kind: "sign_typed_data", file: raw.file };
    }
    return { kind: "sign_typed_data", typedData: raw.typedData };
  }
  throw new PlanBlocked(`${where} has an unknown action type.`);
}

/** Checks one propose() argument. Throws PlanBlocked. */
export function parseBatch(raw: unknown, firstPosition: number): ParsedAction[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new PlanBlocked("propose() needs a non-empty list of actions.");
  if (raw.length > LIMITS.maxTotalActions) {
    throw new PlanBlocked(`The plan has more than ${LIMITS.maxTotalActions.toLocaleString("en-US")} actions, the most one request can carry.`);
  }
  return raw.map((action, i) => parseAction(action, firstPosition + i));
}

/** Checks every batch the program proposed, in order. Throws PlanBlocked. */
export function parseBatches(batches: unknown[]): { action: ParsedAction; batch: number }[] {
  const total = batches.reduce<number>((sum, batch) => sum + (Array.isArray(batch) ? batch.length : 0), 0);
  if (total > LIMITS.maxTotalActions) {
    throw new PlanBlocked(`The plan has more than ${LIMITS.maxTotalActions.toLocaleString("en-US")} actions, the most one request can carry.`);
  }
  const out: { action: ParsedAction; batch: number }[] = [];
  batches.forEach((batch, b) => {
    for (const action of parseBatch(batch, out.length)) out.push({ action, batch: b });
  });
  return out;
}
