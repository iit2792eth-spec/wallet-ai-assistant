import "../wallet/setup";
import { resolveApproval } from "@/approvals/registry";
import type { ApprovalRequest, PlanApproval } from "@/approvals/types";
import { loadManifest } from "@/ai/manifest";
import { checkCode } from "@/ai/verifier/ast-checks";
import { getDb } from "@/db";
import { subscribe } from "@/events/bus";
import type { ServerEvent } from "@/events/types";
import type { DecodedResult } from "@/text-decoder";
import { getVault } from "@/text-encoder";
import { importWallet, lockWallet, unlockWallet } from "@/wallet";

export const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const OWN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const BOB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
export const CAROL = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
export const PASSWORD = "correct horse battery";

let sessionCounter = 0;
export const newSession = () => `00000000-0000-4000-8000-${String(++sessionCounter).padStart(12, "0")}`;

/** A decoded result for `code`, with functions_used filled in so the validator accepts it. */
export function decoded(code: string, functionsUsed?: string[]): DecodedResult {
  const called = checkCode(code, { manifest: loadManifest(), isKnownPlaceholder: () => false, stage: "decoded" }).functionsCalled;
  return { type: "code", code, summary: "Test plan.", functions_used: functionsUsed ?? called, external_fields: [] };
}

/** Marks values as typed by the user (or found in a document) in this session, as the encoder would. */
export function userTyped(sessionId: string, ...values: string[]) {
  getVault(sessionId).encode(values.join(" "), { kind: "user" });
}
export function fromWebPage(sessionId: string, ...values: string[]) {
  getVault(sessionId).encode(values.join(" "), { kind: "web", ref: "https://example.com/invoice" });
}

/** An answer to a card; { selected } approves only those step indexes of a plan card. */
export type Responder = (request: ApprovalRequest) => "approved" | "rejected" | { selected: number[] } | null;

/** Records events for a session and answers approval cards with `respond` (null = never answer). */
export function watch(sessionId: string, respond: Responder = () => "approved") {
  const events: ServerEvent[] = [];
  const unsubscribe = subscribe(sessionId, (event) => {
    events.push(event);
    if (event.type === "approval_request") {
      const answer = respond(event.request);
      if (answer) {
        setTimeout(() => {
          if (typeof answer === "object") resolveApproval(event.request.id, sessionId, "approved", answer.selected);
          else resolveApproval(event.request.id, sessionId, answer);
        }, 0);
      }
    }
  });
  return {
    events,
    unsubscribe,
    approvals: () => events.filter((e): e is Extract<ServerEvent, { type: "approval_request" }> => e.type === "approval_request").map((e) => e.request as PlanApproval),
    steps: () => events.filter((e): e is Extract<ServerEvent, { type: "steps" }> => e.type === "steps"),
    statuses: () => events.filter((e): e is Extract<ServerEvent, { type: "status" }> => e.type === "status").map((e) => e.text),
    outputs: () => events.filter((e) => e.type === "output"),
  };
}

export async function setupWallet({ unlocked = true } = {}) {
  await importWallet({ privateKey: TEST_KEY, password: PASSWORD });
  if (unlocked) await unlockWallet({ password: PASSWORD });
  else lockWallet();
}

export function resetDatabase() {
  const db = getDb();
  db.exec(`
    DROP TRIGGER IF EXISTS actions_no_delete;
    DELETE FROM actions; DELETE FROM spend_limits; DELETE FROM contacts;
    UPDATE settings SET value = '300' WHERE key = 'approval_timeout_seconds';
  `);
}

export const actionRows = () =>
  getDb().prepare("SELECT batch_index AS i, status, approved_by AS by, to_provenance AS provenance, tainted, amount, error FROM actions ORDER BY id").all() as {
    i: number; status: string; by: string | null; provenance: string | null; tainted: number; amount: string | null; error: string | null;
  }[];

/** Sets an enabled spend limit for a token, in base units. */
export function setLimit(symbol: string, perTx: bigint, daily: bigint, weekly: bigint) {
  const db = getDb();
  const token = db.prepare("SELECT id FROM tokens WHERE symbol = ?").get(symbol) as { id: number };
  db.prepare("INSERT OR REPLACE INTO spend_limits (token_id, per_tx_max, daily_max, weekly_max, enabled) VALUES (?, ?, ?, ?, 1)").run(
    token.id, perTx.toString(), daily.toString(), weekly.toString(),
  );
  return token.id;
}

/** A past transfer in the actions table, as wallet.getHistory would see it. */
export function pastTransfer(to: string, symbol: string, amount: bigint, opts: { secondsAgo?: number; status?: string } = {}) {
  const db = getDb();
  const token = db.prepare("SELECT id FROM tokens WHERE symbol = ?").get(symbol) as { id: number };
  db.prepare(
    `INSERT INTO actions (session_id, plan_id, batch_index, kind, chain_id, signer_address, token_id, to_address, to_provenance, amount, status, created_at)
     VALUES ('old', ?, 0, 'transfer', 11155111, ?, ?, ?, 'user', ?, ?, unixepoch() - ?)`,
  ).run(`past-${Math.random()}`, OWN, token.id, to, amount.toString(), opts.status ?? "confirmed", opts.secondsAgo ?? 3600);
}

export const ETH = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * BigInt(1e12);
