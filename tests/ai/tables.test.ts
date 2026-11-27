import { describe, expect, it } from "vitest";
import { runAiLayer } from "@/ai";
import { checkExternalFields } from "@/ai/nodes/code-verifier";
import type { RawTools } from "@/ai/subagents/tools";
import { chunkText } from "@/ai/subagents/extract";
import { checkCode } from "@/ai/verifier/ast-checks";
import { dryRun } from "@/ai/verifier/dry-run";
import { loadManifest } from "@/ai/manifest";
import { decodeTables } from "@/text-decoder";
import { NO_ERRORS, coderReply, completePlan, makeDeps, newSessionId, scriptedModel, segmentAnswerer } from "./helpers/fixtures";

// Lists and tables in documents: extracted in parts, handed to the program as
// data (external.rows), never copied into the model's code.

const FROM = "0xD9CCf2cC1c2eF1ed70b919683D637bb9b996A122";
const addressOf = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}`;
const table = (n: number) => ["From To Amount", ...Array.from({ length: n }, (_, i) => `${FROM} ${addressOf(i)} 0.01`)].join("\n");
const PDF = "/Users/me/Testing.pdf";

const plan = completePlan({
  units: ["ETH"],
  external_data: [{ kind: "pdf", location: PDF, purpose: "recipient and amount of every transaction" }],
});

/** A fake extraction model: each "<from> <to> <amount>" line pays its second address. */
const tableExtractor = segmentAnswerer((text) => {
  const cells = text.trim().split(/\s+/);
  return cells.length === 3 && cells[1].startsWith("[") ? [{ recipient: cells[1], amount: cells[2], unit: "" }] : [];
}, [{ name: "unit", value: "ETH" }]);

const CODE = `const rows = external.rows("payments");
const actions = [];
for (const row of rows) {
  actions.push({ action: "transfer", to: row.recipient, token: "ETH", amount: parseEther(row.amount) });
}
await propose(actions);`;

describe("document tables", () => {
  it("reads a 200-row table in parts and gives the program the rows as data", async () => {
    const rawTools: RawTools = { fetchWebText: async () => "", extractPdfText: async () => table(200) };
    const model = scriptedModel({
      planning: [plan],
      extraction: [tableExtractor],
      coding: [coderReply(CODE, ["external.rows", "parseEther", "propose"], [{ field: "payments", source: "Testing.pdf" }, { field: "unit", source: "Testing.pdf" }])],
      review: [NO_ERRORS],
    });
    const deps = makeDeps(model, { rawTools });
    const run = await runAiLayer(deps, newSessionId(), deps.encoder.encode(`execute the transactions in this pdf: ${PDF}`, { kind: "user" }));

    expect(run.result.type === "code" ? "code" : JSON.stringify(run.result)).toBe("code");
    expect(run.externalTables).toHaveLength(1);
    expect(run.externalTables[0].rows).toHaveLength(200);
    // The document was long enough to be read in more than one part.
    expect(model.calls.filter((c) => c.task === "extraction").length).toBeGreaterThan(1);
    // No model ever saw a real address.
    expect(JSON.stringify(model.calls)).not.toContain(addressOf(5));
    // The Coder saw the table's shape and a sample, not all 200 rows.
    const coder = model.calls.find((c) => c.task === "coding")!.messages.at(-1)!.content;
    expect(coder).toContain("payments from Testing.pdf: columns recipient, amount, unit; 200 rows");
    expect(coder.match(/\[WALLET_ADDRESS_\d+\]/g)!.length).toBeLessThan(10);
  });

  it("refuses a document with more rows than one request can carry, and says why", async () => {
    const rawTools: RawTools = { fetchWebText: async () => "", extractPdfText: async () => table(1_050) };
    const model = scriptedModel({ planning: [plan], extraction: [tableExtractor] });
    const deps = makeDeps(model, { rawTools });
    const run = await runAiLayer(deps, newSessionId(), deps.encoder.encode(`pay everyone in ${PDF}`, { kind: "user" }));
    expect(run.result).toMatchObject({ type: "rejection" });
    expect(run.result.type === "rejection" && run.result.message).toMatch(/has 1,050 lines that look like payments; one request can carry at most 1,000/);
    // Refused before any extraction call was made.
    expect(model.calls.some((c) => c.task === "extraction")).toBe(false);
  });

  it("stops and says so when the model's replies stay unusable", async () => {
    const rawTools: RawTools = { fetchWebText: async () => "", extractPdfText: async () => table(3) };
    const model = scriptedModel({ planning: [plan], extraction: ["not json"] });
    const deps = makeDeps(model, { rawTools });
    const run = await runAiLayer(deps, newSessionId(), deps.encoder.encode(`pay ${PDF}`, { kind: "user" }));
    expect(run.result.type === "rejection" && run.result.message).toMatch(/could not read every payment in Testing.pdf: 3 of 3 lines that look like payments could not be read reliably/);
  });
});

describe("chunkText", () => {
  it("cuts at line breaks and keeps every line", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const parts = chunkText(text, 200);
    expect(parts.every((p) => p.length <= 200)).toBe(true);
    expect(parts.join("\n")).toBe(text);
  });
  it("cuts a single overlong line where it must", () => {
    expect(chunkText("y".repeat(450), 200).map((p) => p.length)).toEqual([200, 200, 50]);
  });
});

describe("decodeTables", () => {
  const vault = new Map([["[WALLET_ADDRESS_1]", addressOf(0)]]);
  const restore = (p: string) => vault.get(p);
  const log = () => {};

  it("restores address cells and leaves other cells alone", () => {
    const out = decodeTables([{ name: "payments", columns: ["recipient", "amount"], rows: [["[WALLET_ADDRESS_1]", "0.5"]], source: "a.pdf" }], restore, log);
    expect(out).toEqual([{ name: "payments", columns: ["recipient", "amount"], rows: [[addressOf(0), "0.5"]] }]);
  });
  it("rejects a secret placeholder anywhere", () => {
    const out = decodeTables([{ name: "t", columns: ["note"], rows: [["key [PRIVATE_KEY_1]"]], source: "a.pdf" }], restore, log);
    expect(out).toMatchObject({ type: "rejection", reason: "forbidden_placeholder" });
  });
  it("rejects an unknown placeholder", () => {
    const out = decodeTables([{ name: "t", columns: ["recipient"], rows: [["[WALLET_ADDRESS_9]"]], source: "a.pdf" }], restore, log);
    expect(out).toMatchObject({ type: "rejection", reason: "unknown_placeholder" });
  });
});

describe("verifier and external.rows", () => {
  const tables = [{ name: "payments", columns: ["recipient", "amount"], rows: [["[WALLET_ADDRESS_1]", "0.5"], ["[WALLET_ADDRESS_2]", "1"]], source: "a.pdf" }];

  it("accepts code that reads a table with external.rows", () => {
    const result = checkCode(CODE, { manifest: loadManifest(), isKnownPlaceholder: () => true });
    expect(result.errors).toEqual([]);
    expect(result.functionsCalled).toContain("external.rows");
  });
  it("requires a table the code reads to be listed in external_fields", () => {
    const draft = { code: CODE, summary: "s", functions_used: ["external.rows", "parseEther", "propose"], external_fields: [] };
    expect(checkExternalFields(draft, [], tables)).toEqual([
      'The code reads the external table payments; list {"field":"payments","source":"a.pdf"} in external_fields',
    ]);
    expect(checkExternalFields({ ...draft, external_fields: [{ field: "payments", source: "a.pdf" }] }, [], tables)).toEqual([]);
  });
  it("runs the program on the real rows in the dry run", async () => {
    const run = await dryRun(CODE, undefined, tables);
    expect(run.error).toBeNull();
    expect(run.proposals[0]).toHaveLength(2);
    expect(run.proposals[0][1]).toMatchObject({ to: "[WALLET_ADDRESS_2]", amount: BigInt("1000000000000000000") });
  });
  it("fails clearly for a table that does not exist", async () => {
    const run = await dryRun(`external.rows("nope");`, undefined, tables);
    expect(run.error).toMatch(/no external table named nope/);
  });
});
