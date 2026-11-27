// Limits and allowlists for the AI layer. All of these are enforced in code.

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Clarification questions allowed for one request before it is aborted. */
export const MAX_CLARIFICATION_ROUNDS = envInt("AI_MAX_CLARIFICATION_ROUNDS", 3);
/** Times the Coder may rewrite code after the verifier rejects it. */
export const MAX_CODE_REVISIONS = envInt("AI_MAX_CODE_REVISIONS", 3);
/** Extra attempts when a model reply is not valid JSON for its schema. */
export const MODEL_OUTPUT_RETRIES = 2;

/** Units a user may write. WEI and GWEI are units of ETH. */
export const SUPPORTED_UNITS = ["ETH", "USDC", "EURC", "WEI", "GWEI"] as const;
/** Tokens an action may move. */
export const TOKENS = ["ETH", "USDC", "EURC"] as const;

export const MAX_CODE_CHARS = 8_000;
export const MAX_CONVERSATION_TURNS = 12;

// Executor
export const MAX_EXTERNAL_SOURCES = 3;
/** Text read from each web page or PDF; the rest is cut off (and the user is told). */
export const MAX_EXTERNAL_TEXT_CHARS = 100_000;
/** Long documents are extracted in chunks of about this many characters, cut at line breaks. */
export const EXTRACTION_CHUNK_CHARS = 6_000;
/** Chunks extracted at the same time. */
export const EXTRACTION_CONCURRENCY = 4;
/** Rows across all tables of a request: the same ceiling as the access layer's actions. */
export const MAX_TABLE_ROWS = 1_000;
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 3;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const PDF_TIMEOUT_MS = 20_000;
