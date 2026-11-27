import { describe, expect, it } from "vitest";
import { isWordless, screenText, type Scorer } from "@/injection-filter";

const A = "0xD9CCf2cC1c2eF1ed70b919683D637bb9b996A122";
const B = "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE";
const HASH = "0x" + "ab".repeat(32);

describe("isWordless", () => {
  it("is true for table rows, amounts, dates and hashes", () => {
    for (const t of [
      `${A} ${B} 0.01`,
      `${A} | ${B} | 0.01 ETH`,
      `${B} 1,250.00 USDC`,
      "2026-11-24 13:05 -> 0.5 ETH",
      HASH,
      "ab".repeat(32),
      "#42 · 12.5% · $1,000",
      "0.01 wstETH",
    ]) expect(isWordless(t), t).toBe(true);
  });

  it("is false as soon as there is one ordinary word", () => {
    for (const t of [
      "From To Amount",
      `${A} ${B} 0.01 send`,
      `send ${B}`,
      `${B} ALL`,
      "0xIgnore 0.01",
      "0xdeadIgnore",
      "Ignore",
      "ETHER 1",
      "USDCx 5",
      "Отправь 1 ETH",
      "ok",
    ]) expect(isWordless(t), t).toBe(false);
  });
});

describe("screenText skips segments with no words", () => {
  it("does not score them and never flags them", async () => {
    const seen: string[] = [];
    const scorer: Scorer = async (texts) => {
      seen.push(...texts);
      return texts.map(() => 0.99);
    };
    const text = `From To Amount\n${A} ${B} 0.01\n${B} ${A} 0.02 ETH`;
    const result = await screenText(text, { scorer, threshold: 0.5 });
    expect(seen).toEqual(["From To Amount"]);
    expect(result.segments.map((s) => s.skipped)).toEqual([false, true, true]);
    expect(result.skippedCount).toBe(2);
    expect(result.flaggedCount).toBe(1);
    expect(result.segments[1]).toMatchObject({ score: 0, flagged: false });
  });

  it("does not call the model when every segment is wordless", async () => {
    const scorer: Scorer = async () => {
      throw new Error("should not be called");
    };
    const result = await screenText(`${A} ${B} 0.01\n${B} ${A} 0.01`, { scorer });
    expect(result).toMatchObject({ flaggedCount: 0, skippedCount: 2 });
  });
});
