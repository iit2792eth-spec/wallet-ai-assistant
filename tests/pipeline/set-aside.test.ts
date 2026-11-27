import { describe, expect, it } from "vitest";
import { setAsideNotices } from "@/pipeline/set-aside";

const display = (text: string) => text.replace("[WALLET_ADDRESS_2]", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");

describe("set-aside notices", () => {
  it("names the document, then each line with its reason, with the user's addresses shown", () => {
    expect(setAsideNotices([{ source: "Testing.pdf", segment: 38, reason: "sender_only", text: "[WALLET_ADDRESS_1] [WALLET_ADDRESS_2] 0.01" }], display)).toEqual([
      "1 line in Testing.pdf that may hold a payment was set aside and will not be paid. Check it against the document:",
      'Line 38 (names only the sender): "[WALLET_ADDRESS_1] 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 0.01"',
    ]);
  });

  it("shows at most five lines per document and counts the rest", () => {
    const lines = Array.from({ length: 7 }, (_, i) => ({ source: "a.pdf", segment: i + 1, reason: "total" as const, text: `Total ${i}` }));
    const notices = setAsideNotices(lines, (t) => t);
    expect(notices[0]).toBe("7 lines in a.pdf that may hold a payment were set aside and will not be paid. Check them against the document:");
    expect(notices).toHaveLength(7);
    expect(notices.at(-1)).toBe("…and 2 more set aside in a.pdf.");
  });

  it("is empty when nothing was set aside", () => {
    expect(setAsideNotices([], (t) => t)).toEqual([]);
  });
});
