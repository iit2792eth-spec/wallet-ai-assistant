import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { splitSegments } from "@/injection-filter";

// The classifier was trained on the Python segmenter's output, so the port must match it exactly.
// The fixture is the Python output for 300 random dataset documents plus edge cases.

type Case = { text: string; segments: [number, number, string][] };
const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "fixtures", "segmenter-parity.json"), "utf8"),
) as { cases: Case[] };

const hasAstral = (text: string) => /[\uD800-\uDBFF]/.test(text);

describe("segmenter", () => {
  it("matches piidata/segmenter.py on every fixture document", () => {
    for (const { text, segments } of fixture.cases) {
      const ours = splitSegments(text);
      expect(ours.map((s) => s.text)).toEqual(segments.map((s) => s[2]));
      // Python offsets count code points, JavaScript UTF-16 units: equal unless the text has astral characters.
      if (!hasAstral(text)) expect(ours.map((s) => [s.start, s.end])).toEqual(segments.map((s) => [s[0], s[1]]));
    }
  });

  it("keeps decimals, abbreviations, URLs and ENS names inside a sentence", () => {
    expect(splitSegments("Dr. Rao sent 0.05 ETH to https://wallet.example/path. Check rahul.eth. Done.").map((s) => s.text)).toEqual([
      "Dr. Rao sent 0.05 ETH to https://wallet.example/path.",
      "Check rahul.eth.",
      "Done.",
    ]);
  });

  it("splits at line breaks and returns offsets into the original text", () => {
    const text = "Invoice 42\n\nPay 25 USDC.  Thanks.";
    for (const s of splitSegments(text)) expect(text.slice(s.start, s.end)).toBe(s.text);
    expect(splitSegments(text).map((s) => s.text)).toEqual(["Invoice 42", "Pay 25 USDC.", "Thanks."]);
  });
});
