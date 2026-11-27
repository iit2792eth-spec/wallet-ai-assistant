import { WalletError, getWalletStatus, type WalletErrorCode } from "@/wallet";
import { crossOriginError, jsonError } from "./http";
import { audit } from "./logger";

const STATUS: Partial<Record<WalletErrorCode, number>> = {
  WALLET_NOT_FOUND: 404,
  WALLET_EXISTS: 409,
  WRONG_PASSWORD: 401,
  WEAK_PASSWORD: 400,
  INVALID_SECRET: 400,
  WALLET_LOCKED: 423,
  TOKEN_NOT_CONFIGURED: 404,
  HTTPS_REQUIRED: 400,
  RPC_UNAVAILABLE: 502,
  RPC_ERROR: 502,
};

/** Turns a wallet failure into a JSON error response. The message is safe to show; nothing private is included. */
export function walletErrorResponse(error: unknown): Response {
  if (error instanceof WalletError) {
    return Response.json({ error: error.message, code: error.code }, { status: STATUS[error.code] ?? 500 });
  }
  return jsonError(500, "Something went wrong in the wallet.");
}

/**
 * Guard for every request that changes saved data (contacts, limits, models, settings).
 * Refuses cross-site requests, and refuses all changes while a wallet exists and is locked,
 * so only someone who knows the wallet password can change what the app trusts.
 * With no wallet yet, changes are allowed so first-time setup works.
 */
export async function changeGuard(request: Request, what: string): Promise<Response | null> {
  const blocked = crossOriginError(request);
  if (blocked) return blocked;
  const status = await getWalletStatus();
  if (status.exists && !status.unlocked) {
    audit("change_blocked_locked", { what });
    return Response.json({ error: "Unlock the wallet to make changes.", code: "WALLET_LOCKED" }, { status: 423 });
  }
  return null;
}
