import { MAX_CLARIFICATION_ROUNDS, SUPPORTED_UNITS } from "../config";
import type { AiDeps } from "../deps";
import { ModelOutputError, callJson } from "../model/call-json";
import { planningMessages } from "../prompts";
import { mostCautious } from "@/lib/modes";
import { placeholderPattern } from "@/lib/placeholders";
import { planningOutputSchema, type AiResult, type Plan, type RejectionReason } from "../schemas";
import type { State, StateUpdate } from "../state";

const reject = (reason: RejectionReason, message: string): StateUpdate => ({
  result: { type: "rejection", reason, message },
});

const normaliseFunction = (name: string) => name.trim().replace(/\(.*\)$/, "");

/** Checks on a finished plan that do not rely on the model having followed its instructions. */
function checkPlan(plan: Plan, deps: AiDeps, userText: string): AiResult | null {
  const { manifest } = deps;

  const named = [...plan.required_functions, ...plan.steps.flatMap((step) => step.functions)].map(normaliseFunction);
  const unknown = [...new Set(named)].filter(
    (name) => name !== "" && !manifest.functionNames.has(name) && !manifest.actionNames.has(name),
  );
  if (unknown.length > 0) {
    return {
      type: "rejection",
      reason: "unsupported_action",
      message: `This needs something I cannot do: ${unknown.join(", ")}. Please ask for something else.`,
    };
  }

  // A percentage ("10%", "2% slippage", "price impact") is a ratio, not a unit: it is never refused as one.
  const isPercentage = (unit: string) => /^(?:\d+(?:\.\d+)?\s*)?(?:%|percent|per\s*cent|bps|basis\s*points?)$/i.test(unit.trim());
  const badUnits = plan.units.filter((unit) => !isPercentage(unit) && !(SUPPORTED_UNITS as readonly string[]).includes(unit.trim().toUpperCase()));
  if (badUnits.length > 0) {
    return {
      type: "rejection",
      reason: "unsupported_unit",
      message: `${badUnits.join(", ")} is not supported. Use one of ${SUPPORTED_UNITS.join(", ")}.`,
    };
  }

  // A .json file is typed data to sign (read by the access layer), never a document for the PDF reader.
  plan.external_data = plan.external_data.filter((item) => !/\.json$/i.test(item.location.split(/[?#]/)[0]));

  // Outbound requests are limited to what the user gave: the model cannot introduce a URL or path.
  for (const item of plan.external_data) {
    if (!userText.includes(item.location)) {
      return {
        type: "rejection",
        reason: "other",
        message: "I can only read a web page or PDF whose URL or path you wrote in your message.",
      };
    }
  }
  return null;
}

/** Invalid-address placeholders in the user's latest message, e.g. a mistyped address. */
function invalidAddresses(state: State): string[] {
  const latest = state.conversation.findLast((turn) => turn.role === "user")?.text ?? "";
  return [...new Set([...latest.matchAll(placeholderPattern())].filter((m) => m[1] === "INVALID_ADDRESS").map((m) => m[0]))];
}

export function planningNode(deps: AiDeps) {
  return async (state: State): Promise<StateUpdate> => {
    const invalid = invalidAddresses(state);
    if (invalid.length > 0) {
      if (state.clarificationRounds >= MAX_CLARIFICATION_ROUNDS) {
        return reject("clarification_limit_exceeded", "The address is still not valid. Please check it and send the whole request again.");
      }
      const list = invalid.join(", ");
      return {
        result: {
          type: "clarification",
          missing: ["recipient"],
          question: `${list} ${invalid.length > 1 ? "are not valid Ethereum addresses" : "is not a valid Ethereum address"}. An address is 0x followed by 40 characters from 0-9 and a-f. Please check it and send it again.`,
        },
      };
    }

    const line = deps.activity?.start("Understanding your request");
    let output;
    try {
      output = await callJson(deps.model, "planning", planningMessages(deps.manifest, state.conversation), planningOutputSchema);
    } catch (error) {
      if (!(error instanceof ModelOutputError)) throw error;
      if (line) deps.activity?.fail(line, "Could not work out a plan");
      return reject("other", "I could not work out a plan for that. Please rephrase your request.");
    }
    if (line) {
      if (output.status === "complete") deps.activity?.done(line, "Understood your request");
      else if (output.status === "clarification") deps.activity?.done(line, "Needs more details from you");
      else deps.activity?.fail(line, "This cannot be done");
    }

    if (output.status === "rejection") return reject(output.reason, output.message);

    if (output.status === "clarification") {
      // Counted here, in code: the model cannot keep the user in a loop of questions.
      if (state.clarificationRounds >= MAX_CLARIFICATION_ROUNDS) {
        return reject(
          "clarification_limit_exceeded",
          "I still do not have what I need. Please send the whole request again in one message, with the amount, unit and recipient.",
        );
      }
      return { result: { type: "clarification", missing: output.missing, question: output.question } };
    }

    const userText = state.conversation
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.text)
      .join("\n");
    const problem = checkPlan(output, deps, userText);
    if (problem) return { result: problem };
    // The model may make a request more cautious than the user's words, never less.
    return { plan: output, mode: mostCautious(output.mode, state.modeCeiling) };
  };
}

export function routeAfterPlanning(state: State): "executor" | "coder" | "__end__" {
  if (state.result) return "__end__";
  return state.plan && state.plan.external_data.length > 0 ? "executor" : "coder";
}
