import type { AiDeps } from "./deps";
import { buildGraph } from "./graph";
import { modeCeiling, type Mode } from "@/lib/modes";
import { aiResultSchema, type AiResult, type ExternalTable, type SetAsideLine } from "./schemas";
import { addTurn, contextFor, getAiSession } from "./session";
import { tracingCallbacks } from "./tracing";

export type AiRun = {
  result: AiResult;
  /** Times the Coder was asked to rewrite its code. */
  revisions: number;
  /** Reviewer objections that did not block the code. Unverified; shown to the user as notes. */
  reviewNotes: string[];
  /** For a code result: what the access layer may do with proposals (explain, prepare or sign). */
  mode: Mode;
  /**
   * True if the request read a web page or PDF. Decided from what the AI layer
   * actually planned and fetched, not from what the model declared.
   */
  external: boolean;
  /**
   * Document tables the code reads with external.rows(), in encoded form
   * (placeholders for addresses). Only tables the code lists in external_fields.
   */
  externalTables: ExternalTable[];
  /** Document lines that could have held a payment but were set aside (encoded). For a code result only. */
  setAside: SetAsideLine[];
};

/**
 * Entry point of the AI layer. Takes the user's message, already encoded by the
 * Text Encoder, and returns exactly one result: code, a clarification, or a rejection.
 * It never runs the code and never sees the result of running it.
 */
export async function runAiLayer(
  deps: AiDeps,
  sessionId: string,
  encodedPrompt: string,
  options: { pasted?: boolean } = {},
): Promise<AiRun> {
  const session = getAiSession(sessionId);
  // A new request starts unless this message answers a clarification question.
  if (session.clarificationRounds === 0) {
    session.request += 1;
    session.requestTexts = [];
  }
  addTurn(session, { role: "user", text: encodedPrompt, kind: options.pasted ? "pasted" : "typed" });
  session.requestTexts.push(encodedPrompt);
  const ceiling = modeCeiling(session.requestTexts.join("\n"));

  const final = await buildGraph(deps).invoke(
    {
      conversation: contextFor(session),
      clarificationRounds: session.clarificationRounds,
      plan: null,
      modeCeiling: ceiling,
      mode: ceiling,
      externalFields: [],
      externalTables: [],
      setAside: [],
      draft: null,
      verifierErrors: [],
      revisions: 0,
      reviewedIssues: [],
      lastFlaggedCode: null,
      reviewNotes: [],
      result: null,
    },
    {
      recursionLimit: 50,
      runName: "ai_layer",
      callbacks: tracingCallbacks(),
      // A random per-tab id, not tied to the user. Groups the runs of one chat in LangSmith.
      metadata: { session_id: sessionId, clarification_round: session.clarificationRounds },
    },
  );

  // Last line of defence: nothing leaves the AI layer unless it matches the output contract.
  const result = aiResultSchema.parse(final.result);

  if (result.type === "clarification") {
    session.clarificationRounds += 1;
    addTurn(session, { role: "assistant", text: result.question, kind: "question" });
  } else {
    session.clarificationRounds = 0;
    // A code result gets its record from the access layer once it has run (see addRecord).
    // Model-written text is never stored as fact: a rejection keeps only its reason.
    if (result.type === "rejection") {
      addTurn(session, { role: "assistant", text: `(Request not carried out: ${result.reason})`, kind: "rejection" });
    }
  }
  return {
    result,
    revisions: final.revisions,
    reviewNotes: result.type === "code" ? final.reviewNotes : [],
    mode: final.mode,
    external:
      (final.plan?.external_data.length ?? 0) > 0 ||
      final.externalFields.length > 0 ||
      (result.type === "code" && result.external_fields.length > 0),
    externalTables:
      result.type === "code"
        ? (final.externalTables ?? []).filter((t) => result.external_fields.some((ref) => ref.field === t.name && ref.source === t.source))
        : [],
    setAside: result.type === "code" ? (final.setAside ?? []) : [],
  };
}
