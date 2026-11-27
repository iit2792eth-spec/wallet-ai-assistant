import "./helpers";
import { rmSync } from "node:fs";
import { expect, it } from "vitest";
import { runPlan } from "@/access";
import { lockWallet } from "@/wallet";
import { fakeRpc } from "../helpers/fake-rpc";
import { decoded, newSession, resetDatabase, setupWallet, watch } from "./helpers";
it("shows every token balance even when one token is unavailable", async () => {
  resetDatabase(); lockWallet(); rmSync(process.env.WALLET_KEYSTORE_PATH!, { force: true }); fakeRpc(); await setupWallet();
  const s = newSession(); const w = watch(s);
  const code = `const lines = [];
for (const token of ["ETH", "USDC", "EURC", "DAI"]) {
  try {
    const balance = await wallet.getBalance({ token });
    lines.push(\`\${token}: \${formatUnits(balance, token)}\`);
  } catch (error) {
    lines.push(\`\${token}: not available on this network\`);
  }
}
ui.show({ title: "Your balances", list: lines });`;
  expect(await runPlan({ sessionId: s, decoded: decoded(code), mode: "sign" })).toBe("completed");
  expect(w.outputs()).toEqual([{ type: "output", content: { type: "list", title: "Your balances", items: ["ETH: 5", "USDC: 25", "EURC: 25", "DAI: not available on this network"] } }]);
});
