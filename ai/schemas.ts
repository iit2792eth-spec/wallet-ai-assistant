import { z } from "zod";
import { MAX_CODE_CHARS, MAX_EXTERNAL_SOURCES } from "./config";
import { MODES } from "@/lib/modes";
import { containsSecretPlaceholder } from "@/lib/placeholders";

// Every model reply is validated against one of these. Unknown fields are rejected.

const noSecretPlaceholders = (text: string) => !containsSecretPlaceholder(text);
const SECRET_MESSAGE = "must not contain a private key or seed phrase placeholder";

const text = (max: number) => z.string().trim().min(1).max(max).refine(noSecretPlaceholders, SECRET_MESSAGE);

// ---- Result returned by the AI layer (section 4.1) ----

export const externalFieldRefSchema = z.strictObject({ field: text(100), source: text(2000) });

export const codeResultSchema = z.strictObject({
  type: z.literal("code"),
  code: z.string().min(1).max(MAX_CODE_CHARS),
  summary: text(1000),
  functions_used: z.array(z.string().max(100)).max(50),
  external_fields: z.array(externalFieldRefSchema).max(50),
});

export const clarificationResultSchema = z.strictObject({
  type: z.literal("clarification"),
  missing: z.array(text(100)).min(1).max(10),
  question: text(1000),
});

export const REJECTION_REASONS = [
  "unsupported_unit",
  "unsupported_action",
  "clarification_limit_exceeded",
  "code_verification_failed",
  "other",
] as const;

export const rejectionResultSchema = z.strictObject({
  type: z.literal("rejection"),
  reason: z.enum(REJECTION_REASONS),
  message: text(1000),
});

export const aiResultSchema = z.discriminatedUnion("type", [
  codeResultSchema,
  clarificationResultSchema,
  rejectionResultSchema,
]);

export type CodeResult = z.infer<typeof codeResultSchema>;
export type AiResult = z.infer<typeof aiResultSchema>;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

// ---- Planning ----

const stepSchema = z.strictObject({
  id: z.number().int().min(1).max(50),
  description: text(500),
  functions: z.array(z.string().max(100)).max(10),
  depends_on: z.array(z.number().int().min(1).max(50)).max(20),
});

export const planSchema = z.strictObject({
  status: z.literal("complete"),
  /** What the user wants: explain, prepare, or sign. The final mode is never less cautious than the user's words allow. */
  mode: z.enum(MODES),
  steps: z.array(stepSchema).min(1).max(20),
  /** Amounts the code must compute at run time from a function result. */
  computed_amounts: z.array(z.strictObject({ step: z.number().int(), expression: text(300) })).max(20),
  required_functions: z.array(z.string().max(100)).max(30),
  /** Every unit or token the user wrote. */
  units: z.array(z.string().max(20)).max(20),
  /** Web pages or PDFs the user asked to take data from. */
  external_data: z
    .array(z.strictObject({ kind: z.enum(["web", "pdf"]), location: z.string().min(1).max(2000), purpose: text(300) }))
    .max(MAX_EXTERNAL_SOURCES),
  summary: text(1000),
});

export const planningOutputSchema = z.discriminatedUnion("status", [
  planSchema,
  z.strictObject({
    status: z.literal("clarification"),
    missing: z.array(text(100)).min(1).max(10),
    question: text(1000),
  }),
  z.strictObject({
    status: z.literal("rejection"),
    reason: z.enum(["unsupported_unit", "unsupported_action", "other"]),
    message: text(1000),
  }),
]);

export type Plan = z.infer<typeof planSchema>;

// ---- Executor ----

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "use a short lowercase name: letters, digits and _");

/** A list or table of rows (payments, recipients...) from a document, one row per entry. */
export const extractedTableSchema = z
  .strictObject({
    name: identifier,
    columns: z.array(identifier).min(1).max(8),
    rows: z.array(z.array(z.string().trim().max(500))).max(400),
  })
  .refine((table) => table.rows.every((row) => row.length === table.columns.length), "every row needs one value per column")
  .refine((table) => new Set(table.columns).size === table.columns.length, "column names must be different");

export const extractionOutputSchema = z.strictObject({
  fields: z.array(z.strictObject({ name: text(100), value: z.string().trim().min(1).max(500) })).max(20),
  tables: z.array(extractedTableSchema).max(3).optional().default([]),
});

/** Why a segment the code picked out holds no payment. */
export const SET_ASIDE_REASONS = ["header", "sender_only", "total", "information", "instruction_to_ignore", "other"] as const;
export type SetAsideReason = (typeof SET_ASIDE_REASONS)[number];

/**
 * The reply for numbered segments of a document: for every segment asked about,
 * the payments it holds, or none and why. Values are checked against the
 * segment's own text in code (ai/subagents/extract.ts).
 */
export const segmentAnswersSchema = z.strictObject({
  fields: z.array(z.strictObject({ name: text(100), value: z.string().trim().min(1).max(500) })).max(20).optional().default([]),
  answers: z
    .array(
      z.strictObject({
        segment: z.number().int().min(1),
        payments: z
          .array(z.strictObject({ recipient: z.string().trim().min(1).max(200), amount: z.string().trim().min(1).max(60), unit: z.string().trim().max(20) }))
          .max(10),
        reason: z.enum(SET_ASIDE_REASONS).optional(),
      }),
    )
    .max(80),
});

/** A value taken from a web page or PDF. Never merged with what the user wrote. */
export type ExternalField = { name: string; value: string; origin: "external"; source: string };

/**
 * Rows taken from a web page or PDF. The program reads them with external.rows(name),
 * as objects keyed by column; they never pass through the model's code.
 */
export type ExternalTable = { name: string; columns: string[]; rows: string[][]; source: string };

/** A line of a document that could have held a payment but was judged not to. Shown on the first approval card. */
export type SetAsideLine = { source: string; segment: number; reason: SetAsideReason; text: string };

// ---- Coder and Code Verifier ----

export const coderOutputSchema = codeResultSchema.omit({ type: true });
export type CoderOutput = z.infer<typeof coderOutputSchema>;

export const REVIEW_CATEGORIES = [
  "wrong_recipient",
  "wrong_amount",
  "wrong_token",
  "wrong_order",
  "missing_step",
  "extra_step",
  "unrequested_action",
  "not_shown_before_propose",
  "unit_mixup",
  "summary_mismatch",
] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];

export const reviewIssueSchema = z.strictObject({
  category: z.enum(REVIEW_CATEGORIES),
  /** The line of code that is wrong, copied exactly. Empty for a missing step or a summary problem. */
  line: z.string().max(500),
  /** What the user asked for that this code does not do. */
  user_asked: z.string().trim().min(1).max(300),
  problem: z.string().trim().min(1).max(500),
});
export type ReviewIssue = z.infer<typeof reviewIssueSchema>;

export const reviewOutputSchema = z.strictObject({ errors: z.array(reviewIssueSchema).max(10) });
