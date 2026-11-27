import type { AiDeps } from "../deps";
import { ModelOutputError, callJson } from "../model/call-json";
import { reviewMessages } from "../prompts";
import { reviewOutputSchema, type CoderOutput, type ReviewIssue } from "../schemas";
import type { State } from "../state";

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();
const LINE_OPTIONAL = new Set(["missing_step", "summary_mismatch", "not_shown_before_propose"]);

/** A stable key for an issue, used to recognise the same objection on a later round. */
export const issueKey = (issue: ReviewIssue) => `${issue.category}|${normalise(issue.line)}`;

export const issueText = (issue: ReviewIssue) =>
  `${issue.problem} (asked: ${issue.user_asked})${issue.line ? ` Line: ${normalise(issue.line)}` : ""}`;

/**
 * Stage (b) of the Code Verifier: a separate model call that looks for places
 * where the code does something other than what the user asked. Best effort only.
 *
 * Issues that point at a line which is not in the code are dropped: the
 * reviewer must show where the problem is. If the reply is unusable the code
 * is not blocked, because stage (a) and the access layer are the guarantees.
 */
export async function reviewCode(deps: AiDeps, state: State, draft: CoderOutput, dryRunReport: string): Promise<ReviewIssue[]> {
  if (!state.plan) return [];
  let issues: ReviewIssue[];
  try {
    ({ errors: issues } = await callJson(
      deps.model,
      "review",
      reviewMessages({
        manifest: deps.manifest,
        turns: state.conversation,
        plan: state.plan,
        externalFields: state.externalFields,
        externalTables: state.externalTables ?? [],
        draft,
        dryRunReport,
      }),
      reviewOutputSchema,
    ));
  } catch (error) {
    if (error instanceof ModelOutputError) return [];
    throw error;
  }
  const code = normalise(draft.code);
  return issues.filter((issue) => {
    const line = normalise(issue.line);
    if (line === "") return LINE_OPTIONAL.has(issue.category);
    return code.includes(line);
  });
}
