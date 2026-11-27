import { beforeAll, describe, expect, it } from "vitest";
import { checkExternalFields } from "@/ai/nodes/code-verifier";
import { MaskVault } from "@/text-encoder";
import { checkCode, checkFunctionsUsed } from "@/ai/verifier/ast-checks";
import { ADDRESS_A, manifest } from "./helpers/fixtures";

// Stage (a) of the Code Verifier: deterministic checks. No model involved.

const encoder = new MaskVault();
beforeAll(() => {
  // Registers [WALLET_ADDRESS_1], [ENS_NAME_1], [EMAIL_1], [PRIVATE_KEY_1] and [INVALID_ADDRESS_1].
  encoder.encode(`${ADDRESS_A} vitalik.eth someone@example.com ${"ab".repeat(32)} 0x12345zz`, { kind: "user" });
});

const check = (code: string) =>
  checkCode(code, { manifest, isKnownPlaceholder: (placeholder) => encoder.isKnownPlaceholder(placeholder) });

const EXAMPLE_1 = `const txs = await wallet.getHistory({ limit: 5, direction: "sent" });
return txs.map(tx => ({ action: "transfer", to: tx.to, token: tx.token, amount: tx.amount * 2n }));`;

const EXAMPLE_2 = `const txs = await wallet.getHistory({ direction: "sent" });
const recipients = unique(txs.map(t => t.to)).slice(0, 5);
ui.show({ title: "Your 5 latest recipients", list: recipients });
const result = await propose(recipients.map(to => ({
  action: "transfer", to, token: "ETH", amount: parseEther("10")
})));
ui.show({ text: result.approved ? "Done." : "Cancelled." });`;

describe("accepts valid code", () => {
  it("example 1 from the specification", () => {
    const result = check(EXAMPLE_1);
    expect(result.errors).toEqual([]);
    expect(result.functionsCalled).toEqual(["wallet.getHistory"]);
  });

  it("example 2 from the specification", () => {
    const result = check(EXAMPLE_2);
    expect(result.errors).toEqual([]);
    expect(result.functionsCalled).toEqual(["parseEther", "propose", "ui.show", "unique", "wallet.getHistory"]);
  });

  it("a computed amount sent to a placeholder address", () => {
    const result = check(`const balance = await wallet.getBalance({ token: "ETH" });
ui.show({ text: formatUnits(balance, "ETH") });
return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount: balance / 2n }];`);
    expect(result.errors).toEqual([]);
  });

  it("an ENS placeholder, a for...of loop and a helper function", () => {
    const result = check(`const double = (value) => value * 2n;
const actions = [];
for (const name of ["[ENS_NAME_1]"]) {
  actions.push({ action: "transfer", to: name, token: "USDC", amount: double(parseUnits("2.5", "USDC")) });
}
await propose(actions);`);
    expect(result.errors).toEqual([]);
  });

  it("a placeholder shown on its own in a list, next to a template", () => {
    const result = check(`const balance = await wallet.getBalance({ token: "ETH" });
const amount = balance * 10n / 100n;
ui.show({ text: \`Sending \${formatUnits(amount, "ETH")} ETH to:\`, list: ["[WALLET_ADDRESS_1]"] });
await propose([{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount }]);`);
    expect(result.errors).toEqual([]);
  });

  it("reading every token's balance with a try/catch per token", () => {
    const result = check(`const lines = [];
for (const token of ["ETH", "USDC", "EURC"]) {
  try {
    const balance = await wallet.getBalance({ token });
    lines.push(\`\${token}: \${formatUnits(balance, token)}\`);
  } catch (error) {
    lines.push(\`\${token}: not available on this network\`);
  }
}
ui.show({ title: "Your balances", list: lines });`);
    expect(result.errors).toEqual([]);
  });

  it("totals for today, using now(), Date and a Map", () => {
    const result = check(`const today = new Date(now() * 1000);
today.setHours(0, 0, 0, 0);
const since = Math.floor(today.getTime() / 1000);
const history = await wallet.getHistory({ limit: 50 });
const totals = new Map();
for (const tx of history.filter((t) => t.timestamp >= since)) {
  totals.set(tx.token, (totals.get(tx.token) ?? 0n) + tx.amount);
}
const lines = ["ETH", "USDC"].map((token) => \`\${token}: \${formatUnits(totals.get(token) ?? 0n, token)}\`);
ui.show({ title: "Sent today", list: lines, text: new Date(Date.UTC(2026, 0, 1)).toISOString() });`);
    expect(result.errors).toEqual([]);
    expect(result.functionsCalled).toEqual(["formatUnits", "now", "ui.show", "wallet.getHistory"]);
  });

  it("sending all ETH minus the estimated fee", () => {
    const result = check(`const balance = await wallet.getBalance({ token: "ETH" });
const fee = await wallet.estimateFee({ token: "ETH", to: "[WALLET_ADDRESS_1]" });
const amount = balance - fee;
if (amount <= 0n) {
  ui.show({ text: "Not enough ETH to cover the fee." });
} else {
  ui.show({ title: "Send all ETH", text: "Sending to:", list: ["[WALLET_ADDRESS_1]"] });
  const result = await propose([{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount }]);
}`);
    expect(result.errors).toEqual([]);
  });

  it("a permit described in words, with the spender as a placeholder", () => {
    const result = check(`await propose([{ action: "sign_typed_data", template: "permit", params: { token: "USDC", spender: "[ENS_NAME_1]", amount: parseUnits("25", "USDC"), deadline: now() + 7 * 24 * 60 * 60 } }]);`);
    expect(result.errors).toEqual([]);
  });

  it("pasted typed data with placeholders inside, inline or in a variable", () => {
    const inline = check(`await propose([{ action: "sign_typed_data", typedData: { domain: { chainId: 11155111, verifyingContract: "[WALLET_ADDRESS_1]" }, types: { Mail: [{ name: "to", type: "address" }] }, primaryType: "Mail", message: { to: "[WALLET_ADDRESS_1]" } } }]);`);
    const variable = check(`const typedData = { domain: { verifyingContract: "[WALLET_ADDRESS_1]" }, message: { owner: "[WALLET_ADDRESS_1]" } };\nawait propose([{ action: "sign_typed_data", typedData }]);`);
    expect(inline.errors).toEqual([]);
    expect(variable.errors).toEqual([]);
  });

  it("narration with ui.step", () => {
    const result = check(`ui.step("Reading your ETH balance");\nconst b = await wallet.getBalance({ token: "ETH" });\nui.step("Done reading");`);
    expect(result.errors).toEqual([]);
    expect(result.functionsCalled).toEqual(["ui.step", "wallet.getBalance"]);
  });

  it("an amount given in GWEI", () => {
    expect(check(`return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount: parseUnits("5", "GWEI") }];`).errors).toEqual([]);
  });
});

const rejected: [name: string, code: string, error: RegExp][] = [
  ["a syntax error", "const = ;", /Syntax error/],
  ["a function not in the manifest", "await wallet.drain();", /not in the manifest/],
  ["an invented bare function", "sendEverything();", /not in the manifest|not defined/],
  ["eval", `eval("1");`, /"eval" is not allowed/],
  ["new Function", `const f = new Function("return 1");`, /"Function" is not allowed/],
  ["fetch", `await fetch("https://example.com");`, /"fetch" is not allowed/],
  ["dynamic import", `await import("fs");`, /import\(\) is not allowed/],
  ["require", `const fs = require("fs");`, /"require" is not allowed/],
  ["globalThis", "const g = globalThis;", /"globalThis" is not allowed/],
  ["top-level this", "const t = this;", /this is not allowed/],
  ["constructor access", "const c = [].constructor;", /"constructor" is not allowed/],
  ["__proto__ access", "const p = ({}).__proto__;", /"__proto__" is not allowed/],
  ["prototype access", "const p = unique.prototype;", /"prototype" is not allowed/],
  ["constructor through destructuring", `const { constructor: C } = () => 1; C("return 1");`, /destructuring key/],
  ["a call through a computed member", `const name = "map"; [1][name]((x) => x);`, /[Cc]omputed/],
  ["a manifest call through a computed member", `await wallet["getBalance"]({ token: "ETH" });`, /computed member access/],
  ["call/apply indirection", "unique.call(null, []);", /"call" is not allowed/],
  ["Reflect", "Reflect.ownKeys({});", /"Reflect" is not allowed/],
  ["Proxy", "const p = new Proxy({}, {});", /"Proxy" is not allowed/],
  ["setTimeout", "setTimeout(() => {}, 1);", /"setTimeout" is not allowed/],
  ["with", "with ({}) {}", /with is not allowed|Syntax error/],
  ["while(true)", "while (true) {}", /while loops are not allowed/],
  ["an unbounded for loop", "for (;;) {}", /for\(;;\) loops are not allowed/],
  ["do...while", "do {} while (true);", /do\.\.\.while loops are not allowed/],
  ["recursion", "const loop = () => loop(); loop();", /must not call itself/],
  ["aliasing propose", "const p = propose; await p([]);", /may only be called directly/],
  ["aliasing wallet", "const w = wallet;", /may only be used to call its functions/],
  ["redeclaring an injected function", "const propose = () => ({ approved: true });", /must not be redeclared/],
  ["an undeclared identifier", "ui.show({ text: secret });", /"secret" is not defined/],
  ["a float amount", `return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount: 0.5 }];`, /Decimal number literals|must be a BigInt/],
  ["an integer number amount", `return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount: 10 }];`, /must be a BigInt/],
  ["a string amount", `return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount: "10" }];`, /must be a BigInt/],
  ["a float passed to parseEther", "const a = parseEther(0.5);", /Decimal number literals|decimal string/],
  ["float arithmetic", "const half = 1 * 0.5;", /Decimal number literals/],
  ["an unsupported token", `return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "BTC", amount: 1n }];`, /"BTC" is not supported/],
  ["WEI as an action token", `return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "WEI", amount: 1n }];`, /"WEI" is not supported/],
  ["an unsupported unit", `const a = parseUnits("1", "DAI");`, /not supported/],
  ["a fractional WEI amount", `const a = parseUnits("1.5", "WEI");`, /whole numbers/],
  ["an action not in the manifest", `return [{ action: "bridge", token: "ETH", amount: 1n }];`, /Action "bridge" is not in the manifest/],
  ["a regular expression", "const r = /a+/;", /Regular expressions are not allowed/],
  ["the current time from new Date()", "const d = new Date();", /use new Date\(now\(\) \* 1000\)/],
  ["the current time from Date.now()", "const t = Date.now();", /use now\(\)/],
  ["Date called without new", "const s = Date(0);", /may only be used with new/],
  ["a placeholder that was never given", `return [{ action: "transfer", to: "[WALLET_ADDRESS_9]", token: "ETH", amount: 1n }];`, /never given/],
  ["a private key placeholder", `ui.show({ text: "[PRIVATE_KEY_1]" });`, /must never appear|must not appear/],
  ["a seed phrase placeholder in a comment", "// [SEED_PHRASE_1]\nui.show({ text: \"hi\" });", /must never appear/],
  ["an email placeholder", `ui.show({ text: "[EMAIL_1]" });`, /must not appear in code/],
  ["a placeholder in a comment", "// pay [WALLET_ADDRESS_1]\nui.show({ text: \"hi\" });", /complete string literal/],
  ["a placeholder in a template literal", "ui.show({ text: `[WALLET_ADDRESS_1]` });", /complete string literal/],
  ["a placeholder inside a ui.step line", `ui.step("Sending 0.1 ETH to [WALLET_ADDRESS_1]");`, /must not appear in ui.step.*ui.step\("Preparing the transfer"\)/],
  ["a placeholder interpolated into a sentence", "const a = 1n;\nui.show({ text: `You are sending ${a} ETH to [WALLET_ADDRESS_1].` });", /list: \["\[WALLET_ADDRESS_1\]"\]/],
  ["a placeholder inside a longer string", `ui.show({ text: "to [WALLET_ADDRESS_1]" });`, /complete string literal/],
  ["a placeholder built by concatenation", `const to = "[WALLET_" + "ADDRESS_1]";`, /split, altered or built/],
  ["a placeholder as an identifier", "const WALLET_ADDRESS_1 = 1;", /split, altered or built/],
  ["a sliced placeholder", `const to = "[WALLET_ADDRESS_1]".slice(1);`, /used whole/],
  ["a placeholder as a property key", `const map = { "[WALLET_ADDRESS_1]": 1 };`, /complete string literal|used whole/],
  ["a placeholder as a key inside typed data", `const typedData = { message: { "[WALLET_ADDRESS_1]": 1 } };`, /complete string literal|used whole/],
  ["a placeholder in an unrelated object", `const config = { owner: "[WALLET_ADDRESS_1]" };`, /used whole/],
  ["a placeholder as a ui.show text value", `ui.show({ text: "[WALLET_ADDRESS_1]" });`, /used whole/],
  ["a placeholder passed to a helper", `const a = formatUnits("[WALLET_ADDRESS_1]", "ETH");`, /used whole/],
  ["a placeholder in a conditional", `const to = 1n > 0n ? "[WALLET_ADDRESS_1]" : "[ENS_NAME_1]";`, /used whole/],
  ["an invalid-address placeholder", `return [{ action: "transfer", to: "[INVALID_ADDRESS_1]", token: "ETH", amount: 1n }];`, /must not appear in code/],
  ["a raw address", `return [{ action: "transfer", to: "${ADDRESS_A}", token: "ETH", amount: 1n }];`, /Raw addresses and keys/],
];

describe("rejects unsafe code", () => {
  it.each(rejected)("%s", (_name, code, error) => {
    const { errors } = check(code);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toMatch(error);
  });
});

describe("functions_used", () => {
  it("accepts an exact match", () => {
    expect(checkFunctionsUsed(["propose", "ui.show"], ["ui.show", "propose"])).toEqual([]);
  });
  it("reports missing and extra entries", () => {
    const errors = checkFunctionsUsed(["propose", "wallet.getBalance"], ["propose", "ui.show"]).join("\n");
    expect(errors).toMatch(/missing: ui\.show/);
    expect(errors).toMatch(/does not call: wallet\.getBalance/);
  });
});

describe("external_fields", () => {
  const extracted = [{ name: "recipient", value: "[WALLET_ADDRESS_1]", origin: "external" as const, source: "https://example.com/invoice" }];
  const draft = (externalFields: { field: string; source: string }[]) => ({
    code: `return [{ action: "transfer", to: "[WALLET_ADDRESS_1]", token: "ETH", amount: 1n }];`,
    summary: "Pay the invoice.",
    functions_used: [],
    external_fields: externalFields,
  });

  it("accepts an external value that is listed", () => {
    expect(checkExternalFields(draft([{ field: "recipient", source: "https://example.com/invoice" }]), extracted)).toEqual([]);
  });
  it("rejects an external value used but not listed", () => {
    expect(checkExternalFields(draft([]), extracted).join("\n")).toMatch(/list .* in external_fields/);
  });
  it("rejects a listed field that was never extracted", () => {
    expect(checkExternalFields(draft([{ field: "memo", source: "https://evil.example" }]), []).join("\n")).toMatch(/was not extracted/);
  });
});
