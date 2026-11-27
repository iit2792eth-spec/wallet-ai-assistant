import { Annotation } from "@langchain/langgraph";
import type { Mode } from "@/lib/modes";
import type { AiResult, CoderOutput, ExternalField, ExternalTable, Plan, SetAsideLine } from "./schemas";

/** One line of the encoded conversation the AI layer may see. */
/**
 * One line of the encoded conversation the AI layer may see.
 * kind: typed or pasted (user); question (a clarification the planner asked);
 * record (what the access layer actually did, from fixed templates); rejection.
 * request: which request it belongs to.
 */
export type Turn = {
  role: "user" | "assistant";
  text: string;
  kind?: "typed" | "pasted" | "question" | "record" | "rejection";
  request?: number;
};

export const GraphState = Annotation.Root({
  /** Encoded conversation, ending with the user's latest message. */
  conversation: Annotation<Turn[]>(),
  /** Clarification questions already asked for this request. */
  clarificationRounds: Annotation<number>(),
  plan: Annotation<Plan | null>(),
  /** The least cautious mode the user's own words allow (decided in code). */
  modeCeiling: Annotation<Mode>(),
  /** The request's mode: the planner's reading, capped by modeCeiling. */
  mode: Annotation<Mode>(),
  externalFields: Annotation<ExternalField[]>(),
  /** Lists and tables from documents, read by the program with external.rows(name). */
  externalTables: Annotation<ExternalTable[]>(),
  /** Document lines that could have held a payment but were set aside, for the approval card. */
  setAside: Annotation<SetAsideLine[]>(),
  /** The Coder's latest output, or null if its reply was not valid. */
  draft: Annotation<CoderOutput | null>(),
  /** Errors from the last verification, fed back to the Coder. */
  verifierErrors: Annotation<string[]>(),
  /** Times the Coder has been asked to rewrite. */
  revisions: Annotation<number>(),
  /** Reviewer issues already sent to the Coder, so a repeated one does not block again. */
  reviewedIssues: Annotation<string[]>(),
  /** The code the reviewer last flagged, so unchanged code is recognised. */
  lastFlaggedCode: Annotation<string | null>(),
  /** Reviewer objections that did not block. Shown to the user as unverified notes. */
  reviewNotes: Annotation<string[]>(),
  /** Set by the node that ends the run. */
  result: Annotation<AiResult | null>(),
});

export type State = typeof GraphState.State;
export type StateUpdate = typeof GraphState.Update;
