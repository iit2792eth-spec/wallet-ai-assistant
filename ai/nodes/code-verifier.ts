import { MAX_CODE_REVISIONS } from "../config";
import type { AiDeps } from "../deps";
import { placeholderType } from "@/lib/placeholders";
import { aiResultSchema, type CoderOutput, type ExternalField, type ExternalTable } from "../schemas";
import type { State, StateUpdate } from "../state";
import { checkCode, checkFunctionsUsed } from "../verifier/ast-checks";
import { describeDryRun, dryRun } from "../verifier/dry-run";
import { issueKey, issueText, reviewCode } from "../verifier/llm-review";

/**
 * external_fields must name real extracted fields or tables, every external value
 * in the code must be listed, and every table the code reads must be listed.
 */
export function checkExternalFields(draft: CoderOutput, extracted: ExternalField[], tables: ExternalTable[] = []): string[] {
  const errors: string[] = [];
  const listed = new Set(draft.external_fields.map((ref) => `${ref.field}\n${ref.source}`));

  for (const ref of draft.external_fields) {
    const known =
      extracted.some((field) => field.name === ref.field && field.source === ref.source) ||
      tables.some((table) => table.name === ref.field && table.source === ref.source);
    if (!known) errors.push(`external_fields lists "${ref.field}" from "${ref.source}", which was not extracted from any document`);
  }
  for (const table of tables) {
    const read = new RegExp(`external\\.rows\\(\\s*["'\`]${table.name}["'\`]\\s*\\)`).test(draft.code);
    const usesCell = table.rows.some((row) => row.some((cell) => /^\[[A-Z_]+_\d+\]$/.test(cell) && (draft.code.includes(`"${cell}"`) || draft.code.includes(`'${cell}'`))));
    if ((read || usesCell) && !listed.has(`${table.name}\n${table.source}`)) {
      errors.push(`The code reads the external table ${table.name}; list {"field":"${table.name}","source":"${table.source}"} in external_fields`);
    }
  }
  for (const field of extracted) {
    const inCode = draft.code.includes(`"${field.value}"`) || draft.code.includes(`'${field.value}'`);
    if (inCode && !listed.has(`${field.name}\n${field.source}`)) {
      const shown = placeholderType(field.value) ? field.value : field.name;
      errors.push(`The code uses the external value ${shown}; list {"field":"${field.name}","source":"${field.source}"} in external_fields`);
    }
  }
  return errors;
}

/** Stage (a): deterministic checks on the source. Exported so tests can run it without a model. */
export function deterministicChecks(deps: AiDeps, draft: CoderOutput, extracted: ExternalField[], tables: ExternalTable[] = []): string[] {
  const ast = checkCode(draft.code, {
    manifest: deps.manifest,
    isKnownPlaceholder: (placeholder) => deps.encoder.isKnownPlaceholder(placeholder),
  });
  if (ast.errors.length > 0) return ast.errors;
  return [...checkFunctionsUsed(draft.functions_used, ast.functionsCalled), ...checkExternalFields(draft, extracted, tables)];
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

export function codeVerifierNode(deps: AiDeps) {
  return async (state: State): Promise<StateUpdate> => {
    const { draft } = state;
    const update: StateUpdate = {};
    let errors: string[] = [];
    const line = deps.activity?.start("Checking the program");

    if (!draft) {
      errors = ["Your reply was not a valid JSON object in the required format."];
    } else {
      // Stage (a): deterministic. Always blocks.
      errors = deterministicChecks(deps, draft, state.externalFields, state.externalTables ?? []);

      if (errors.length === 0) {
        // Still stage (a): run the code on sample data. Catches errors that only appear at run time.
        const run = await dryRun(draft.code, undefined, state.externalTables ?? []);
        if (run.error) {
          errors = [`The code failed when run with sample data: ${run.error}. Fix the code so it runs without errors.`];
        } else {
          // Stage (b): model review, given what the code actually did on sample data.
          const issues = await reviewCode(deps, state, draft, describeDryRun(run));
          const seen = new Set(state.reviewedIssues);
          const unchanged = state.lastFlaggedCode !== null && normalise(draft.code) === state.lastFlaggedCode;

          // The review is best effort, so it gets one say on each issue. The Coder may
          // keep its code if it judges the reviewer wrong. If the code comes back
          // unchanged, or the same objection is raised again, it is recorded as an
          // unverified note instead of blocking. A disagreement cannot loop.
          const blocking = unchanged ? [] : issues.filter((issue) => !seen.has(issueKey(issue)));
          const notes = issues.filter((issue) => !blocking.includes(issue)).map(issueText);

          update.reviewNotes = [...state.reviewNotes, ...notes];
          if (blocking.length > 0) {
            errors = blocking.map((issue) => `Reviewer (${issue.category}): ${issueText(issue)}`);
            update.reviewedIssues = [...state.reviewedIssues, ...blocking.map(issueKey)];
            update.lastFlaggedCode = normalise(draft.code);
          }
        }
      }
    }

    if (errors.length === 0 && draft) {
      if (line) deps.activity?.done(line, "The program passed the checks");
      return { ...update, result: aiResultSchema.parse({ type: "code", ...draft }) };
    }
    if (line) {
      deps.activity?.fail(line, state.revisions >= MAX_CODE_REVISIONS ? "Still failing the checks, giving up" : `Found ${errors.length} problem${errors.length === 1 ? "" : "s"}, rewriting`);
    }
    if (state.revisions >= MAX_CODE_REVISIONS) {
      return {
        ...update,
        result: {
          type: "rejection",
          reason: "code_verification_failed",
          message: "I could not write code for that which passes the safety checks. Try a simpler request, or split it into steps.",
        },
      };
    }
    return { ...update, verifierErrors: errors, revisions: state.revisions + 1 };
  };
}

export const routeAfterVerifier = (state: State): "coder" | "__end__" => (state.result ? "__end__" : "coder");
