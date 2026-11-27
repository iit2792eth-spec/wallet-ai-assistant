import { audit, shortAddress } from "@/lib/logger";

// Wallet log lines go to the audit log. They carry public, shortened values
// only: never a private key, seed phrase, password, signature or full address.

/** Shortens a transaction hash or digest for logs: 0x1234…cdef. */
export const shortHash = (hash: string) => `${hash.slice(0, 6)}…${hash.slice(-4)}`;
export { shortAddress };

export function walletLog(event: string, detail: Record<string, unknown> = {}): void {
  // audit() also redacts anything that slipped through: keys, hashes, emails; addresses are shortened.
  audit(`wallet_${event}`, detail);
}

/** A short description of an error for the log: its class and wallet code, not its full message. */
export function errorSummary(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object") {
    const e = error as { name?: string; code?: string; cause?: { name?: string; shortMessage?: string } };
    return { error: e.code ?? e.name ?? "Error", cause: e.cause?.name, detail: e.cause?.shortMessage?.slice(0, 160) };
  }
  return { error: "Error" };
}
