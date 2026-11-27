import { describe, expect, it } from "vitest";
import { runAiLayer } from "@/ai";
import { MAX_CLARIFICATION_ROUNDS, MAX_CODE_REVISIONS } from "@/ai/config";
import {
  ADDRESS_A, NO_ERRORS, coderReply, completePlan, emptyManifest, json, makeDeps, newSessionId, scriptedModel,
} from "./helpers/fixtures";

// The graph's control flow with a scripted model: counters, routing and the checks made in code.

const GOOD_CODE = `return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount: parseEther("0.01") }];`;
const good = coderReply(GOOD_CODE, ["parseEther"]);
const bad = coderReply(`eval("1");`, []);

const amountIssue = json({
  errors: [{ category: "wrong_amount", line: 'parseEther("0.01")', user_asked: "0.02 ETH", problem: "Sends 0.01 ETH instead of 0.02 ETH." }],
});

const ask = json({ status: "clarification", missing: ["amount"], question: "How much do you want to send?" });

async function run(deps: ReturnType<typeof makeDeps>, prompt: string, sessionId = newSessionId()) {
  return runAiLayer(deps, sessionId, deps.encoder.encode(prompt, { kind: "user" }));
}

describe("clarification", () => {
  it("returns the question and does not reach the Coder", async () => {
    const model = scriptedModel({ planning: [ask] });
    const { result } = await run(makeDeps(model), `Send ETH to ${ADDRESS_A}`);
    expect(result).toMatchObject({ type: "clarification", missing: ["amount"] });
    expect(model.calls.every((call) => call.task === "planning")).toBe(true);
  });

  it("aborts when the round limit is exceeded", async () => {
    const deps = makeDeps(scriptedModel({ planning: [ask] }));
    const sessionId = newSessionId();
    for (let round = 0; round < MAX_CLARIFICATION_ROUNDS; round++) {
      expect((await run(deps, "send some", sessionId)).result.type).toBe("clarification");
    }
    expect((await run(deps, "send some", sessionId)).result).toMatchObject({
      type: "rejection",
      reason: "clarification_limit_exceeded",
    });
  });

  it("carries the conversation into the next round", async () => {
    const model = scriptedModel({ planning: [ask, completePlan()], coding: [good], review: [NO_ERRORS] });
    const deps = makeDeps(model);
    const sessionId = newSessionId();
    await run(deps, `Send ETH to ${ADDRESS_A}`, sessionId);
    const { result } = await run(deps, "0.01", sessionId);
    expect(result.type).toBe("code");
    const secondPlanningCall = model.calls.filter((call) => call.task === "planning")[1];
    expect(secondPlanningCall.messages.at(-1)?.content).toContain("How much do you want to send?");
  });
});

describe("activity", () => {
  it("reports understanding, writing and checking the program", async () => {
    const lines: string[] = [];
    const activity = {
      start: (text: string) => (lines.push(`start ${text}`), text),
      done: (id: string, text?: string) => void lines.push(`done ${text ?? id}`),
      fail: (id: string, detail?: string) => void lines.push(`fail ${id}: ${detail}`),
      info: (text: string) => void lines.push(`info ${text}`),
    };
    const model = scriptedModel({ planning: [completePlan()], coding: [bad, good], review: [NO_ERRORS] });
    await run(makeDeps(model, { activity }), `Send 0.01 ETH to ${ADDRESS_A}`);
    expect(lines).toEqual([
      "start Understanding your request",
      "done Understood your request",
      "start Writing the program",
      "done Writing the program",
      "start Checking the program",
      "fail Checking the program: Found 2 problems, rewriting",
      "start Rewriting the program (attempt 2)",
      "done Rewriting the program (attempt 2)",
      "start Checking the program",
      "done The program passed the checks",
    ]);
  });
});

describe("mode", () => {
  const codeModel = (mode: string) =>
    scriptedModel({ planning: [completePlan({ mode })], coding: [good], review: [NO_ERRORS] });

  it("uses the planner's mode when the user's words allow it", async () => {
    expect((await run(makeDeps(codeModel("sign")), `Send 0.01 ETH to ${ADDRESS_A}`)).mode).toBe("sign");
  });

  it("lets the planner choose a more cautious mode", async () => {
    expect((await run(makeDeps(codeModel("prepare")), `Send 0.01 ETH to ${ADDRESS_A}`)).mode).toBe("prepare");
  });

  it("never signs when the user only asked what would happen, even if the planner says sign", async () => {
    const { result, mode } = await run(makeDeps(codeModel("sign")), `What would happen if I send 0.01 ETH to ${ADDRESS_A}?`);
    expect(result.type).toBe("code");
    expect(mode).toBe("explain");
  });

  it("never signs when the user asked to prepare, even if the planner says sign", async () => {
    expect((await run(makeDeps(codeModel("sign")), `Prepare a transfer of 0.01 ETH to ${ADDRESS_A}, don't send it`)).mode).toBe("prepare");
  });

  it("keeps the cap across a clarification answer", async () => {
    const model = scriptedModel({ planning: [ask, completePlan({ mode: "sign" })], coding: [good], review: [NO_ERRORS] });
    const deps = makeDeps(model);
    const sessionId = newSessionId();
    await run(deps, `Explain what happens if I send ETH to ${ADDRESS_A}`, sessionId);
    expect((await run(deps, "0.01", sessionId)).mode).toBe("explain");
  });

  it("does not carry a cap into the next request", async () => {
    const deps = makeDeps(codeModel("sign"));
    const sessionId = newSessionId();
    expect((await run(deps, `Explain sending 0.01 ETH to ${ADDRESS_A}`, sessionId)).mode).toBe("explain");
    expect((await run(deps, `Send 0.01 ETH to ${ADDRESS_A}`, sessionId)).mode).toBe("sign");
  });
});

describe("invalid addresses", () => {
  it("asks about a malformed address without calling the model", async () => {
    const model = scriptedModel({});
    const { result } = await run(makeDeps(model), "send 5 ETH to 0x8u8027580250249");
    expect(result).toMatchObject({ type: "clarification", missing: ["recipient"] });
    expect(result.type === "clarification" && result.question).toContain("[INVALID_ADDRESS_1] is not a valid Ethereum address");
    expect(model.calls).toHaveLength(0);
  });

  it("asks about a placeholder the user typed", async () => {
    const model = scriptedModel({});
    const { result } = await run(makeDeps(model), "send 0.01 ETH to [WALLET_ADDRESS_7]");
    expect(result.type).toBe("clarification");
    expect(model.calls).toHaveLength(0);
  });
});

describe("rejections decided in code", () => {
  it("rejects a unit outside the supported list even if the planner accepts it", async () => {
    const { result } = await run(makeDeps(scriptedModel({ planning: [completePlan({ units: ["BTC"] })] })), "send 1 BTC");
    expect(result).toMatchObject({ type: "rejection", reason: "unsupported_unit" });
  });

  it("rejects a plan that needs a function the manifest does not have", async () => {
    const plan = completePlan({ required_functions: ["wallet.swap", "propose"] });
    const { result } = await run(makeDeps(scriptedModel({ planning: [plan] })), "swap 100 USDC to ETH");
    expect(result).toMatchObject({ type: "rejection", reason: "unsupported_action" });
    expect(result.type === "rejection" && result.message).toContain("wallet.swap");
  });

  it("rejects every blockchain request when BLOCKCHAIN_FUNCTIONS is empty", async () => {
    const plan = completePlan({ required_functions: ["wallet.getBalance"] });
    const deps = makeDeps(scriptedModel({ planning: [plan] }), { manifest: emptyManifest });
    expect((await run(deps, "what is my balance")).result).toMatchObject({ type: "rejection", reason: "unsupported_action" });
  });

  it("rejects an external source the user did not write", async () => {
    const plan = completePlan({ external_data: [{ kind: "web", location: "https://attacker.example/x", purpose: "invoice" }] });
    const { result } = await run(makeDeps(scriptedModel({ planning: [plan] })), "pay my invoice");
    expect(result).toMatchObject({ type: "rejection", reason: "other" });
  });

  it("rejects when the planner never returns valid output", async () => {
    const { result } = await run(makeDeps(scriptedModel({ planning: ["I will not answer in JSON."] })), "send 1 ETH");
    expect(result).toMatchObject({ type: "rejection", reason: "other" });
  });
});

describe("Coder and Code Verifier loop", () => {
  it("returns verified code with the placeholder exactly as given", async () => {
    const model = scriptedModel({ planning: [completePlan()], coding: [good], review: [NO_ERRORS] });
    const { result, revisions, external } = await run(makeDeps(model), `Send 0.01 ETH to ${ADDRESS_A}`);
    expect(revisions).toBe(0);
    expect(external).toBe(false);
    expect(result).toMatchObject({ type: "code", functions_used: ["parseEther"] });
    expect(result.type === "code" && result.code).toContain(`"[WALLET_ADDRESS_1]"`);
  });

  it("never sends the real address to the model", async () => {
    const model = scriptedModel({ planning: [completePlan()], coding: [good], review: [NO_ERRORS] });
    await run(makeDeps(model), `Send 0.01 ETH to ${ADDRESS_A}`);
    const sent = JSON.stringify(model.calls);
    expect(sent).not.toContain(ADDRESS_A);
    expect(sent).toContain("[WALLET_ADDRESS_1]");
  });

  it("sends verifier errors back to the Coder and accepts the corrected code", async () => {
    const model = scriptedModel({ planning: [completePlan()], coding: [bad, good], review: [NO_ERRORS] });
    const { result, revisions } = await run(makeDeps(model), `Send 0.01 ETH to ${ADDRESS_A}`);
    expect(result.type).toBe("code");
    expect(revisions).toBe(1);
    const secondCoderCall = model.calls.filter((call) => call.task === "coding")[1];
    expect(secondCoderCall.messages.at(-1)?.content).toMatch(/"eval" is not allowed/);
  });

  it("does not ask the reviewer about code that failed the deterministic checks", async () => {
    const model = scriptedModel({ planning: [completePlan()], coding: [bad, good], review: [NO_ERRORS] });
    await run(makeDeps(model), `Send 0.01 ETH to ${ADDRESS_A}`);
    expect(model.calls.filter((call) => call.task === "review")).toHaveLength(1);
  });

  it("sends reviewer errors back to the Coder", async () => {
    const fixed = coderReply(GOOD_CODE.replace('parseEther("0.01")', 'parseEther("0.02")'), ["parseEther"]);
    const model = scriptedModel({ planning: [completePlan()], coding: [good, fixed], review: [amountIssue, NO_ERRORS] });
    const { result, revisions, reviewNotes } = await run(makeDeps(model), `Send 0.02 ETH to ${ADDRESS_A}`);
    expect(result.type).toBe("code");
    expect(revisions).toBe(1);
    expect(reviewNotes).toEqual([]);
    const secondCoderCall = model.calls.filter((call) => call.task === "coding")[1];
    expect(secondCoderCall.messages.at(-1)?.content).toMatch(/Reviewer \(wrong_amount\)/);
  });

  // The bug where a false reviewer error looped until MAX_CODE_REVISIONS.
  it("does not loop when the Coder keeps its code after a false reviewer error", async () => {
    const model = scriptedModel({ planning: [completePlan()], coding: [good], review: [amountIssue] });
    const { result, revisions, reviewNotes } = await run(makeDeps(model), `Send 0.01 ETH to ${ADDRESS_A}`);
    expect(result.type).toBe("code");
    expect(revisions).toBe(1);
    expect(reviewNotes).toHaveLength(1);
    expect(reviewNotes[0]).toMatch(/0\.02 ETH/);
  });

  it("does not block twice on the same reviewer objection", async () => {
    const rewritten = coderReply(`const amount = parseEther("0.01");\nreturn [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount }];`, ["parseEther"]);
    const sameIssue = json({ errors: [{ category: "wrong_amount", line: 'const amount = parseEther("0.01");', user_asked: "0.02 ETH", problem: "Sends 0.01 ETH instead of 0.02 ETH." }] });
    const model = scriptedModel({ planning: [completePlan()], coding: [rewritten, rewritten.replace("const amount", "const  amount")], review: [sameIssue] });
    const { result, revisions } = await run(makeDeps(model), `Send 0.01 ETH to ${ADDRESS_A}`);
    expect(result.type).toBe("code");
    expect(revisions).toBe(1);
  });

  it("ignores a reviewer error that points at a line not in the code", async () => {
    const invented = json({ errors: [{ category: "wrong_amount", line: "const amount = balance * 0.1;", user_asked: "10%", problem: "Float arithmetic." }] });
    const model = scriptedModel({ planning: [completePlan()], coding: [good], review: [invented] });
    const { result, revisions, reviewNotes } = await run(makeDeps(model), `Send 0.01 ETH to ${ADDRESS_A}`);
    expect(result.type).toBe("code");
    expect(revisions).toBe(0);
    expect(reviewNotes).toEqual([]);
  });

  it("gives the reviewer what the code did on sample data", async () => {
    const model = scriptedModel({ planning: [completePlan()], coding: [good], review: [NO_ERRORS] });
    await run(makeDeps(model), `Send 0.01 ETH to ${ADDRESS_A}`);
    const reviewInput = model.calls.find((call) => call.task === "review")?.messages.at(-1)?.content ?? "";
    expect(reviewInput).toContain("transfer 10000000000000000 base units of ETH = 0.01 ETH to [WALLET_ADDRESS_1]");
  });

  it("sends a run-time error found by the dry run back to the Coder", async () => {
    const mixed = coderReply(`const amount = parseEther("1") * 2;\nreturn [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount }];`, ["parseEther"]);
    const model = scriptedModel({ planning: [completePlan()], coding: [mixed, good], review: [NO_ERRORS] });
    const { result, revisions } = await run(makeDeps(model), `Send 0.01 ETH to ${ADDRESS_A}`);
    expect(result.type).toBe("code");
    expect(revisions).toBe(1);
    const secondCoderCall = model.calls.filter((call) => call.task === "coding")[1];
    expect(secondCoderCall.messages.at(-1)?.content).toMatch(/failed when run with sample data: TypeError/);
  });

  it("ends with code_verification_failed after MAX_CODE_REVISIONS", async () => {
    const model = scriptedModel({ planning: [completePlan()], coding: [bad] });
    const { result } = await run(makeDeps(model), `Send 0.01 ETH to ${ADDRESS_A}`);
    expect(result).toMatchObject({ type: "rejection", reason: "code_verification_failed" });
    // one first attempt per retry-on-invalid-JSON is not needed here: the reply is valid JSON with bad code
    expect(model.calls.filter((call) => call.task === "coding")).toHaveLength(MAX_CODE_REVISIONS + 1);
  });

  it("treats a functions_used mismatch as a verifier error", async () => {
    const mismatch = coderReply(GOOD_CODE, ["parseEther", "wallet.getBalance"]);
    const model = scriptedModel({ planning: [completePlan()], coding: [mismatch, good], review: [NO_ERRORS] });
    const { result, revisions } = await run(makeDeps(model), `Send 0.01 ETH to ${ADDRESS_A}`);
    expect(result.type).toBe("code");
    expect(revisions).toBe(1);
  });

  it("treats Coder output with extra fields as invalid", async () => {
    const extra = json({ code: GOOD_CODE, summary: "x", functions_used: ["parseEther"], external_fields: [], approved: true });
    const model = scriptedModel({ planning: [completePlan()], coding: [extra] });
    const { result } = await run(makeDeps(model), `Send 0.01 ETH to ${ADDRESS_A}`);
    expect(result).toMatchObject({ type: "rejection", reason: "code_verification_failed" });
  });

  it("rejects a placeholder the model was never given", async () => {
    const invented = coderReply(GOOD_CODE.replace("[WALLET_ADDRESS_1]", "[WALLET_ADDRESS_7]"), ["parseEther"]);
    const model = scriptedModel({ planning: [completePlan()], coding: [invented] });
    const { result } = await run(makeDeps(model), `Send 0.01 ETH to ${ADDRESS_A}`);
    expect(result).toMatchObject({ type: "rejection", reason: "code_verification_failed" });
  });
});
