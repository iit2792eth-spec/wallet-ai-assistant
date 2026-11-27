import { describe, expect, it } from "vitest";
import { modeCeiling, mostCautious } from "@/lib/modes";

describe("modeCeiling", () => {
  it.each([
    ["Send 0.1 ETH to Ravi", "sign"],
    ["Check my balance and send half to anuneet.eth", "sign"],
    ["Explain what sending 1 ETH to Ravi would do", "explain"],
    ["What would happen if I sent all my USDC to Ravi?", "explain"],
    ["what if I send 2 ETH", "explain"],
    ["Simulate a transfer of 5 USDC", "explain"],
    ["Prepare a transfer of 1 ETH to Ravi", "prepare"],
    ["Draft a payment of 10 USDC", "prepare"],
    ["Send 1 ETH to Ravi but don't send it yet", "prepare"],
    ["Build it without signing", "prepare"],
    ["Prepare a transfer and explain it", "explain"],
  ])("%s -> %s", (text, expected) => {
    expect(modeCeiling(text)).toBe(expected);
  });
});

describe("mostCautious", () => {
  it("picks the more cautious mode", () => {
    expect(mostCautious("sign", "explain")).toBe("explain");
    expect(mostCautious("prepare", "sign")).toBe("prepare");
    expect(mostCautious("sign", "sign")).toBe("sign");
  });
});
