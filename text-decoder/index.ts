import { parse, type AnyNode } from "acorn";
import { ancestor } from "acorn-walk";
import { codeResultSchema, type CodeResult, type ExternalTable } from "@/ai/schemas";
import { audit } from "@/lib/logger";
import { isPlaceholderPosition } from "@/lib/placeholder-positions";
import type { SandboxTable } from "@/lib/sandbox-prelude";
import {
  CODE_PLACEHOLDER_TYPES,
  SECRET_PLACEHOLDER_TYPES,
  placeholderPattern,
  placeholderType,
} from "@/lib/placeholders";

// The Text Decoder (docs/Text_decoder.txt), adapted to the AI layer's code
// result: the AI layer outputs a program, not a list of action proposals.
//
// It validates the result, then restores wallet address and ENS placeholders
// that stand alone in an address position (the code form of the spec's
// "eligible fields", shared with the Code Verifier). Deterministic: no model,
// no guessing. All or nothing: one bad placeholder rejects the whole result.
// It does not judge whether the code is safe or allowed; the access layer does.

export type DecoderRejectionReason =
  | "schema_violation"
  | "unknown_placeholder"
  | "forbidden_placeholder"
  | "placeholder_in_ineligible_field";

export type DecoderRejection = { type: "rejection"; reason: DecoderRejectionReason; message: string };

/** The same shape as the AI layer's code result, with placeholders restored in `code`. */
export type DecodedResult = CodeResult;

/** Looks up a placeholder in the encoder's mapping. Returns only wallet addresses and ENS names. */
export type RestoreLookup = (placeholder: string) => string | undefined;

export type DecoderLog = (event: string, detail: Record<string, unknown>) => void;

// Shown to the user, so they never contain a restored value or anything from the mapping.
const MESSAGES: Record<DecoderRejectionReason, string> = {
  schema_violation: "The request could not be processed because the generated plan was not in the expected form. Please try again.",
  unknown_placeholder: "The request could not be processed because it referenced a value that was not recognised. Please try again.",
  forbidden_placeholder: "The request could not be processed. Secrets are never used in requests.",
  placeholder_in_ineligible_field: "The request could not be processed because a value appeared in the wrong field. Please try again.",
};

/** The model only ever sees placeholders, so a raw address or key in its code was invented or tampered with. */
const RAW_ADDRESS_OR_KEY = /(?<![0-9A-Za-z])(?:0x)?[0-9a-fA-F]{64}(?![0-9A-Za-z])|(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/;

type Found = { placeholder: string; start: number; end: number; line: number };

class Rejection extends Error {
  constructor(
    readonly reason: DecoderRejectionReason,
    readonly diagnostic: Record<string, unknown>,
  ) {
    super(reason);
  }
}

function decode(input: unknown, restore: RestoreLookup): DecodedResult {
  // 1. Schema. Nothing is repaired.
  const parsed = codeResultSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Rejection("schema_violation", { at: issue.path.join("."), issue: issue.message });
  }
  const result = parsed.data;

  // 2. Private keys and seed phrases anywhere in the result.
  const everything = JSON.stringify(result);
  for (const match of everything.matchAll(placeholderPattern())) {
    if ((SECRET_PLACEHOLDER_TYPES as readonly string[]).includes(match[1])) {
      throw new Rejection("forbidden_placeholder", { type: match[1] });
    }
  }

  // 3. The code must parse, and must not contain a raw address or key.
  let program: AnyNode;
  try {
    program = parse(result.code, {
      ecmaVersion: 2020,
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    }) as AnyNode;
  } catch {
    throw new Rejection("schema_violation", { issue: "code does not parse" });
  }
  if (RAW_ADDRESS_OR_KEY.test(result.code)) {
    throw new Rejection("schema_violation", { issue: "code contains a raw address or key" });
  }

  // 4. Find every placeholder that is a whole string literal, and check where it stands.
  const literals: Found[] = [];
  ancestor(program, {
    Literal(node: AnyNode, _state: unknown, ancestors: AnyNode[]) {
      if (node.type !== "Literal" || typeof node.value !== "string") return;
      const type = placeholderType(node.value);
      if (!type) return;
      const line = node.loc?.start.line ?? 0;
      if (!CODE_PLACEHOLDER_TYPES.includes(type)) {
        throw new Rejection("placeholder_in_ineligible_field", { type, line, issue: "type cannot be restored" });
      }
      if (!isPlaceholderPosition(node, ancestors.at(-2), ancestors)) {
        throw new Rejection("placeholder_in_ineligible_field", { placeholder: node.value, line, issue: "not an address position" });
      }
      literals.push({ placeholder: node.value, start: node.start, end: node.end, line });
    },
  } as never);

  // A placeholder anywhere else (comment, template, longer string) is embedded, which is an error.
  const wholeLiteralStarts = new Set(literals.map((found) => found.start + 1));
  for (const match of result.code.matchAll(placeholderPattern())) {
    if (!wholeLiteralStarts.has(match.index)) {
      throw new Rejection("placeholder_in_ineligible_field", { placeholder: match[0], issue: "embedded in a longer string, template or comment" });
    }
  }

  // 5. Look every placeholder up before changing anything: all or nothing.
  const restored = literals.map((found) => {
    const value = restore(found.placeholder);
    if (value === undefined) throw new Rejection("unknown_placeholder", { placeholder: found.placeholder, line: found.line });
    return { ...found, value };
  });

  // 6. Replace from the end so earlier offsets stay valid.
  let code = result.code;
  for (const { start, end, value } of [...restored].sort((a, b) => b.start - a.start)) {
    code = code.slice(0, start) + JSON.stringify(value) + code.slice(end);
  }
  return { ...result, code };
}

/**
 * Validates an AI layer code result and restores its placeholders from the
 * encoder's mapping. Returns the decoded result, or a rejection to show the user.
 * Diagnostics go to the redacted log; restored values are never logged.
 */
export function decodeCodeResult(input: unknown, restore: RestoreLookup, log: DecoderLog = audit): DecodedResult | DecoderRejection {
  try {
    const decoded = decode(input, restore);
    log("decoder_ok", {});
    return decoded;
  } catch (error) {
    if (!(error instanceof Rejection)) throw error;
    log("decoder_rejection", { reason: error.reason, ...error.diagnostic });
    return { type: "rejection", reason: error.reason, message: MESSAGES[error.reason] };
  }
}

/**
 * Restores the document tables a program reads with external.rows(): a cell
 * that is exactly a wallet address or ENS placeholder becomes the real value;
 * every other cell stays as it is (other placeholders stay masked). All or
 * nothing, like the code: a secret placeholder anywhere, or an unknown one,
 * rejects the whole result. Restored values are never logged.
 */
export function decodeTables(tables: ExternalTable[], restore: RestoreLookup, log: DecoderLog = audit): SandboxTable[] | DecoderRejection {
  try {
    const out = tables.map((table) => ({
      name: table.name,
      columns: [...table.columns],
      rows: table.rows.map((row, r) =>
        row.map((cell, c) => {
          for (const match of cell.matchAll(placeholderPattern())) {
            if ((SECRET_PLACEHOLDER_TYPES as readonly string[]).includes(match[1])) {
              throw new Rejection("forbidden_placeholder", { table: table.name, row: r + 1, column: table.columns[c] });
            }
          }
          const type = placeholderType(cell.trim());
          if (!type || !CODE_PLACEHOLDER_TYPES.includes(type)) return cell;
          const value = restore(cell.trim());
          if (value === undefined) throw new Rejection("unknown_placeholder", { table: table.name, row: r + 1, column: table.columns[c] });
          return value;
        }),
      ),
    }));
    if (tables.length) log("decoder_tables_ok", { tables: tables.length, rows: tables.reduce((n, t) => n + t.rows.length, 0) });
    return out;
  } catch (error) {
    if (!(error instanceof Rejection)) throw error;
    log("decoder_rejection", { reason: error.reason, ...error.diagnostic });
    return { type: "rejection", reason: error.reason, message: MESSAGES[error.reason] };
  }
}
