import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/** data/audit.log, or AUDIT_LOG_PATH (used by tests so they never write to the real log). */
const logFile = () => process.env.AUDIT_LOG_PATH || path.join(process.cwd(), "data", "audit.log");

type Replacement = string | ((match: string) => string);

/** Shortens a public address for logs: 0x1234…7890. */
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

const REDACTIONS: [RegExp, Replacement][] = [
  // 64 hex characters: a private key, or a hash or signature part. Never logged.
  [/(?:0x)?[0-9a-fA-F]{64,}/g, "[redacted-hex]"],
  // Public wallet addresses are shortened, not removed, so log lines stay useful.
  [/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, shortAddress],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[redacted-email]"],
  [/\b(?:sk|pk|key)-[\w-]{16,}/g, "[redacted-api-key]"],
];

/** Removes keys, hashes, emails and API keys, and shortens addresses, before text is logged or shown. */
export function redact(text: string): string {
  return REDACTIONS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement as (match: string) => string),
    text,
  );
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactValue(inner)]));
  }
  return value;
}

/**
 * Appends one line to the audit log (data/audit.log, JSON Lines). Pass
 * structured fields, never raw prompts. Values are redacted before writing.
 */
export function audit(event: string, detail: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...(redactValue(detail) as object) });
  const file = logFile();
  mkdir(path.dirname(file), { recursive: true })
    .then(() => appendFile(file, line + "\n"))
    .catch((error) => console.error("[audit] write failed:", error instanceof Error ? error.message : error));
}
