// Messages pushed from the server to the browser over SSE.
// Shared by server and browser. Keep free of server-only imports.
import type { ApprovalDecision, ApprovalRequest } from "@/approvals/types";
import type { Mode } from "@/lib/modes";

/** Structured content the access layer shows to the user (ui.show). */
export type UiContent =
  | { type: "text"; text: string }
  | { type: "list"; title?: string; items: string[] }
  | { type: "keyValue"; title?: string; rows: { label: string; value: string }[] }
  | { type: "table"; title?: string; columns: string[]; rows: string[][] };

export type StatusLevel = "info" | "success" | "error";

/**
 * One line of a request's activity stream. Lines with the same id are updates
 * of the same line (for example running, then done).
 * source: "system" lines are written by the app's own code and are factual;
 * "program" lines are the generated program's narration (ui.step).
 * level: "detail" lines sit under the step before them (for example a wallet read).
 */
export type ActivityEntry = {
  id: string;
  text: string;
  state: "running" | "done" | "failed" | "waiting" | "info";
  source: "system" | "program";
  level?: "step" | "detail";
  detail?: string;
};

/** One line of a steps card. */
export type StepLine = {
  text: string;
  state: "ready" | "blocked" | "done" | "pending" | "failed" | "skipped";
  /** Extra detail: why it cannot run, the fee, or a signature to copy. */
  detail?: string;
  /** Block explorer link for a transaction. */
  link?: string;
};

export type ServerEvent =
  | { type: "message"; text: string }
  | { type: "output"; content: UiContent }
  | { type: "status"; level: StatusLevel; text: string }
  /** A list of steps: what a plan would do, what was prepared, or what happened. */
  | { type: "steps"; title: string; steps: StepLine[]; footer?: string }
  /** Signing is needed and the wallet is locked: the UI should ask for the password. */
  | { type: "unlock_required" }
  /** Adds or updates a line of the request's activity stream (grouped by `group`). */
  | { type: "activity"; group: string; entry: ActivityEntry }
  /** The request has finished: its activity stream is complete. */
  | { type: "activity_end"; group: string }
  /** The request is being worked on (true) or has finished (false). */
  | { type: "busy"; busy: boolean }
  /** What the code written for a request will do. Shown before anything runs. */
  | { type: "code_result"; summary: string; mode: Mode; externalFields: { field: string; source: string }[] }
  | { type: "approval_request"; request: ApprovalRequest }
  | { type: "approval_resolved"; id: string; decision: ApprovalDecision; selected?: number[] };
