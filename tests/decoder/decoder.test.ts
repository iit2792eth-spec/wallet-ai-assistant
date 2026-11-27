import { describe, expect, it } from "vitest";
import { decodeCodeResult, type DecoderLog } from "@/text-decoder";
import { MaskVault } from "@/text-encoder";

// Text Decoder (docs/Text_decoder.txt), applied to the AI layer's code result.

const ADDRESS_1 = "0x1234567890123456789012345678901234567890";
const ADDRESS_2 = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const KEY = "0x1234567890123456789012345678901234567890123456789012345678901234";

function setup() {
  const vault = new MaskVault();
  // [WALLET_ADDRESS_1], [WALLET_ADDRESS_2], [ENS_NAME_1], [EMAIL_1], [PRIVATE_KEY_1]
  vault.encode(`${ADDRESS_1} ${ADDRESS_2} ravi.eth me@example.com ${KEY}`, { kind: "user" });
  const logs: { event: string; detail: Record<string, unknown> }[] = [];
  const log: DecoderLog = (event, detail) => logs.push({ event, detail });
  const run = (code: string, overrides: Record<string, unknown> = {}) =>
    decodeCodeResult(
      { type: "code", code, summary: "Does what you asked.", functions_used: [], external_fields: [], ...overrides },
      (placeholder) => vault.restore(placeholder),
      log,
    );
  return { vault, logs, run };
}

const decodedCode = (result: ReturnType<ReturnType<typeof setup>["run"]>) => (result.type === "code" ? result.code : null);

describe("restores placeholders in address positions", () => {
  it.each([
    ["a transfer recipient", `return [{ action: "transfer", to: "[WALLET_ADDRESS_2]", token: "ETH", amount: parseEther("0.5") }];`, `to: "${ADDRESS_2}"`],
    ["a getBalance address", `const b = await wallet.getBalance({ token: "ETH", address: "[WALLET_ADDRESS_1]" });`, `address: "${ADDRESS_1}"`],
    ["a lookupEns argument", `const n = await wallet.lookupEns("[WALLET_ADDRESS_1]");`, `lookupEns("${ADDRESS_1}")`],
    ["a resolveEns argument", `const a = await wallet.resolveEns("[ENS_NAME_1]");`, `resolveEns("ravi.eth")`],
    ["a ui.show list item", `ui.show({ text: "Sending to:", list: ["[WALLET_ADDRESS_1]"] });`, `list: ["${ADDRESS_1}"]`],
    ["a variable", `const to = "[WALLET_ADDRESS_1]";`, `const to = "${ADDRESS_1}";`],
    ["a comparison", `const mine = (await wallet.getHistory({})).filter((tx) => tx.to === "[WALLET_ADDRESS_2]");`, `tx.to === "${ADDRESS_2}"`],
    ["an address deep inside pasted typed data", `await propose([{ action: "sign_typed_data", typedData: { domain: { verifyingContract: "[WALLET_ADDRESS_2]" }, message: { owner: "[WALLET_ADDRESS_1]", items: [{ to: "[WALLET_ADDRESS_2]" }] } } }]);`, `items: [{ to: "${ADDRESS_2}" }]`],
    ["a permit spender in params", `await propose([{ action: "sign_typed_data", template: "permit", params: { token: "USDC", spender: "[ENS_NAME_1]", amount: 1n } }]);`, `spender: "ravi.eth"`],
    ["an ENS name as recipient", `return [{ action: "transfer", to: "[ENS_NAME_1]", token: "USDC", amount: parseUnits("10", "USDC") }];`, `to: "ravi.eth"`],
  ])("%s", (_name, code, expected) => {
    const result = setup().run(code);
    expect(result.type).toBe("code");
    expect(decodedCode(result)).toContain(expected);
  });

  it("restores several placeholders and keeps everything else unchanged", () => {
    const code = `const recipients = ["[WALLET_ADDRESS_1]", "[WALLET_ADDRESS_2]"];
ui.show({ title: "Recipients", list: recipients });
return recipients.map((to) => ({ action: "transfer", to, token: "USDC", amount: parseUnits("2.5", "USDC") }));`;
    const result = setup().run(code, { summary: "Send 2.5 USDC to [WALLET_ADDRESS_1] and [WALLET_ADDRESS_2]." });
    expect(decodedCode(result)).toBe(code.replace("[WALLET_ADDRESS_1]", ADDRESS_1).replace("[WALLET_ADDRESS_2]", ADDRESS_2));
    // The summary is display text for the user interface, not restored here.
    expect(result.type === "code" && result.summary).toBe("Send 2.5 USDC to [WALLET_ADDRESS_1] and [WALLET_ADDRESS_2].");
  });

  it("leaves code without placeholders unchanged", () => {
    const code = `const b = await wallet.getBalance({ token: "ETH" });\nui.show({ text: formatUnits(b, "ETH") });`;
    expect(decodedCode(setup().run(code))).toBe(code);
  });

  it("is deterministic", () => {
    const code = `return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount: 1n }];`;
    expect(setup().run(code)).toEqual(setup().run(code));
  });
});

describe("rejections", () => {
  const cases: [string, string, Record<string, unknown>, string][] = [
    ["an unknown placeholder", `return [{ action: "transfer", to: "[WALLET_ADDRESS_9]", token: "ETH", amount: 1n }];`, {}, "unknown_placeholder"],
    ["a private key placeholder in code", `const k = "[PRIVATE_KEY_1]";`, {}, "forbidden_placeholder"],
    ["a private key placeholder in a comment", `// [PRIVATE_KEY_1]\nconst a = 1n;`, {}, "forbidden_placeholder"],
    ["a seed phrase placeholder in the summary", `const a = 1n;`, { summary: "Uses [SEED_PHRASE_1]" }, "schema_violation"],
    ["a seed phrase placeholder in external_fields", `const a = 1n;`, { external_fields: [{ field: "x", source: "[SEED_PHRASE_1]" }] }, "schema_violation"],
    ["a placeholder in a ui.show text", `ui.show({ text: "[WALLET_ADDRESS_1]" });`, {}, "placeholder_in_ineligible_field"],
    ["a placeholder as an amount", `return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount: "[WALLET_ADDRESS_2]" }];`, {}, "placeholder_in_ineligible_field"],
    ["a placeholder as an object key", `const m = { "[WALLET_ADDRESS_1]": 1n };`, {}, "placeholder_in_ineligible_field"],
    ["a placeholder embedded in a longer string", `ui.show({ list: ["to [WALLET_ADDRESS_1]"] });`, {}, "placeholder_in_ineligible_field"],
    ["a placeholder in a template literal", "ui.show({ text: `to [WALLET_ADDRESS_1]` });", {}, "placeholder_in_ineligible_field"],
    ["a placeholder in a comment", `// pay [WALLET_ADDRESS_1]\nconst a = 1n;`, {}, "placeholder_in_ineligible_field"],
    ["an email placeholder", `const e = "[EMAIL_1]";`, {}, "placeholder_in_ineligible_field"],
    ["an invalid-address placeholder", `return [{ action: "transfer", to: "[INVALID_ADDRESS_1]", token: "ETH", amount: 1n }];`, {}, "placeholder_in_ineligible_field"],
    ["code that does not parse", `const = ;`, {}, "schema_violation"],
    ["an extra field", `const a = 1n;`, { approved: true }, "schema_violation"],
    ["a wrong field type", `const a = 1n;`, { functions_used: "propose" }, "schema_violation"],
    ["an invented result type", `const a = 1n;`, { type: "proposals" }, "schema_violation"],
  ];

  it.each(cases)("%s", (_name, code, overrides, reason) => {
    const result = setup().run(code, overrides);
    expect(result).toMatchObject({ type: "rejection", reason });
  });

  it("rejects malformed input that is not an object", () => {
    const { vault } = setup();
    expect(decodeCodeResult("{ not json", (p) => vault.restore(p), () => {})).toMatchObject({ reason: "schema_violation" });
  });

  it("rejects the whole result when only one placeholder is bad (all or nothing)", () => {
    const code = `return [
  { action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount: 1n },
  { action: "transfer", to: "[WALLET_ADDRESS_7]", token: "ETH", amount: 1n },
];`;
    const result = setup().run(code);
    expect(result).toMatchObject({ type: "rejection", reason: "unknown_placeholder" });
    expect(JSON.stringify(result)).not.toContain(ADDRESS_1);
  });
});

describe("tampering", () => {
  it("catches a plausible address the model was never given", () => {
    const result = setup().run(`return [{ action: "transfer", to: "0x9999999999999999999999999999999999999999", token: "ETH", amount: 1n }];`);
    expect(result).toMatchObject({ type: "rejection", reason: "schema_violation" });
  });

  it("catches a placeholder number the encoder never issued", () => {
    expect(setup().run(`const to = "[WALLET_ADDRESS_3]";`)).toMatchObject({ reason: "unknown_placeholder" });
  });

  // Not detectable here: both placeholders are valid. The swap is visible on the
  // approval card, which shows the real recipient; only the user and the access layer can catch it.
  it("cannot catch one valid placeholder swapped for another (documented limit)", () => {
    const result = setup().run(`return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount: 1n }];`);
    expect(result.type).toBe("code");
    expect(decodedCode(result)).toContain(ADDRESS_1);
  });
});

describe("mapping hygiene", () => {
  it("never puts a restored value or the mapping in a rejection message or log", () => {
    const { run, logs } = setup();
    const results = [
      run(`return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount: "[WALLET_ADDRESS_2]" }];`),
      run(`const k = "[PRIVATE_KEY_1]";`),
      run(`const to = "[WALLET_ADDRESS_9]";`),
      run(`return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount: 1n }];`),
    ];
    const visible = JSON.stringify(results.filter((r) => r.type === "rejection")) + JSON.stringify(logs);
    for (const secret of [ADDRESS_1, ADDRESS_2, KEY, "ravi.eth", "me@example.com"]) expect(visible).not.toContain(secret);
  });

  it("restores nothing after the session's mapping is cleared", () => {
    const { vault, run } = setup();
    vault.clear();
    expect(run(`const to = "[WALLET_ADDRESS_1]";`)).toMatchObject({ reason: "unknown_placeholder" });
  });
});
