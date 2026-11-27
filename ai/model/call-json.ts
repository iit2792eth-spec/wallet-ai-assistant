import type { z } from "zod";
import { MODEL_OUTPUT_RETRIES } from "../config";
import type { ChatMessage, ModelPort, ModelTask } from "../ports";

export class ModelOutputError extends Error {}

/** Pulls the JSON object out of a model reply, tolerating code fences and stray text around it. */
function extractJson(reply: string): unknown {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(reply.slice(start, end + 1));
}

/**
 * Asks the model for JSON and validates it against the schema. On an invalid
 * reply the model is told what was wrong and asked again, a limited number of times.
 */
export async function callJson<S extends z.ZodType>(
  model: ModelPort,
  task: ModelTask,
  messages: ChatMessage[],
  schema: S,
): Promise<z.infer<S>> {
  const history = [...messages];
  let problem = "";

  for (let attempt = 0; attempt <= MODEL_OUTPUT_RETRIES; attempt++) {
    const reply = await model.invoke(task, history);
    try {
      const parsed = schema.safeParse(extractJson(reply));
      if (parsed.success) return parsed.data;
      const issue = parsed.error.issues[0];
      problem = `${issue.path.join(".") || "output"}: ${issue.message}`;
    } catch (error) {
      problem = error instanceof Error ? error.message : "invalid JSON";
    }
    history.push(
      { role: "assistant", content: reply.slice(0, 4000) },
      { role: "user", content: `Your reply was not valid (${problem}). Reply with only the JSON object, no other text.` },
    );
  }
  throw new ModelOutputError(`Model output for ${task} was invalid: ${problem}`);
}
