import type { AiDeps } from "../deps";
import { ModelOutputError, callJson } from "../model/call-json";
import { coderMessages } from "../prompts";
import { coderOutputSchema } from "../schemas";
import type { State, StateUpdate } from "../state";

export function coderNode(deps: AiDeps) {
  return async (state: State): Promise<StateUpdate> => {
    if (!state.plan) throw new Error("Coder reached without a plan");
    const messages = coderMessages({
      manifest: deps.manifest,
      turns: state.conversation,
      plan: state.plan,
      externalFields: state.externalFields,
      externalTables: state.externalTables ?? [],
      previous: state.draft,
      errors: state.verifierErrors,
    });
    const line = deps.activity?.start(state.revisions > 0 ? `Rewriting the program (attempt ${state.revisions + 1})` : "Writing the program");
    try {
      const draft = await callJson(deps.model, "coding", messages, coderOutputSchema);
      if (line) deps.activity?.done(line);
      return { draft };
    } catch (error) {
      if (!(error instanceof ModelOutputError)) throw error;
      if (line) deps.activity?.fail(line, "The reply was not in the expected form");
      return { draft: null }; // the verifier reports this as an error and the revision counter applies
    }
  };
}
