import { describe, expect, it } from "vitest";
import { ModelOutputError, callJson } from "@/ai/model/call-json";
import { aiResultSchema, coderOutputSchema, planningOutputSchema } from "@/ai/schemas";
import { json, scriptedModel } from "./helpers/fixtures";

// Output validation: every model reply and every result is checked against a strict schema.

describe("result schema", () => {
  it("accepts the three result types", () => {
    expect(aiResultSchema.safeParse({ type: "code", code: "return [];", summary: "Nothing.", functions_used: [], external_fields: [] }).success).toBe(true);
    expect(aiResultSchema.safeParse({ type: "clarification", missing: ["amount"], question: "How much?" }).success).toBe(true);
    expect(aiResultSchema.safeParse({ type: "rejection", reason: "unsupported_unit", message: "No." }).success).toBe(true);
  });

  it("rejects an invented result type", () => {
    expect(aiResultSchema.safeParse({ type: "transfer", to: "x", amount: "1" }).success).toBe(false);
  });

  it("rejects extra fields", () => {
    expect(aiResultSchema.safeParse({ type: "clarification", missing: ["amount"], question: "How much?", approve: true }).success).toBe(false);
    expect(coderOutputSchema.safeParse({ code: "return [];", summary: "x", functions_used: [], external_fields: [], sign: true }).success).toBe(false);
  });

  it("rejects an unknown rejection reason", () => {
    expect(aiResultSchema.safeParse({ type: "rejection", reason: "because", message: "No." }).success).toBe(false);
  });

  it("rejects a private key or seed phrase placeholder in a summary or question", () => {
    expect(aiResultSchema.safeParse({ type: "code", code: "return [];", summary: "Use [PRIVATE_KEY_1].", functions_used: [], external_fields: [] }).success).toBe(false);
    expect(aiResultSchema.safeParse({ type: "clarification", missing: ["x"], question: "Is [SEED_PHRASE_1] right?" }).success).toBe(false);
  });

  it("rejects a plan with unknown fields", () => {
    expect(planningOutputSchema.safeParse({ status: "complete", steps: [], extra: 1 }).success).toBe(false);
  });
});

describe("callJson", () => {
  const schema = aiResultSchema;
  const good = json({ type: "clarification", missing: ["amount"], question: "How much?" });

  it("accepts JSON wrapped in a code fence", async () => {
    const model = scriptedModel({ planning: ["```json\n" + good + "\n```"] });
    await expect(callJson(model, "planning", [], schema)).resolves.toMatchObject({ type: "clarification" });
  });

  it("retries after malformed JSON and tells the model what was wrong", async () => {
    const model = scriptedModel({ planning: ["not json at all", good] });
    await expect(callJson(model, "planning", [], schema)).resolves.toMatchObject({ type: "clarification" });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1].messages.at(-1)?.content).toMatch(/not valid/);
  });

  it("gives up after the retry limit", async () => {
    const model = scriptedModel({ planning: ["{ broken"] });
    await expect(callJson(model, "planning", [], schema)).rejects.toBeInstanceOf(ModelOutputError);
    expect(model.calls).toHaveLength(3);
  });
});
