import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/ai/ports";
import { IncompleteExtractionError, extractFields, isCandidate } from "@/ai/subagents/extract";
import { MaskVault } from "@/text-encoder";
import { firstPlaceholder, scriptedModel, segmentAnswerer } from "./helpers/fixtures";

// Extraction by numbered segments: code counts the segments that could hold a
// payment and checks that each got an answer, and that every value is written
// in the document. Works the same for tables and for prose, web pages and PDFs.

const FROM = "0xD9CCf2cC1c2eF1ed70b919683D637bb9b996A122";
const addressOf = (i: number) => `0x${(i + 1).toString(16).padStart(40, "0")}`;
const SOURCE = { kind: "pdf" as const, ref: "Testing.pdf" };

function setup(text: string, source: { kind: "pdf" | "web"; ref: string } = SOURCE) {
  const encoder = new MaskVault();
  const encodedContent = encoder.encode(text, source);
  return { encoder, encodedContent };
}

const askedIn = (messages: ChatMessage[]) => (/Answer for: (.*)/.exec(messages.at(-1)!.content)?.[1] ?? "").split(", ").filter(Boolean);
const tableRow = (text: string) => {
  const cells = text.trim().split(/\s+/);
  return cells.length === 3 && cells[1].startsWith("[") ? [{ recipient: cells[1], amount: cells[2], unit: "" }] : [];
};

describe("extraction by segments", () => {
  const TABLE = ["From To Amount", ...Array.from({ length: 99 }, (_, i) => `${FROM} ${addressOf(i)} 0.01`)].join("\n");

  it("asks again for rows the model skipped, and ends with every row", async () => {
    let call = 0;
    const answer = segmentAnswerer(tableRow);
    // The first reply for each batch drops every third segment, as a model copying similar rows does.
    const dropping = (messages: ChatMessage[]) => {
      call += 1;
      const reply = JSON.parse(answer(messages));
      if (call <= 3) reply.answers = reply.answers.filter((_: unknown, i: number) => i % 3 !== 0);
      return JSON.stringify(reply);
    };
    const model = scriptedModel({ extraction: [dropping] });
    const { encoder, encodedContent } = setup(TABLE);
    const out = await extractFields({ model, encoder, purpose: "every transaction", source: SOURCE, encodedContent });
    expect(out.candidates).toBe(99);
    expect(out.tables[0].rows).toHaveLength(99);
    // Rows stay in document order.
    expect(out.tables[0].rows.map((r) => r[0])).toEqual(Array.from({ length: 99 }, (_, i) => `[WALLET_ADDRESS_${i + 2}]`));
    // The retry asked only for the missing segments.
    const retry = model.calls.at(-1)!.messages;
    expect(askedIn(retry).length).toBeLessThan(40);
  });

  it("stops and names the rows when the model keeps skipping them", async () => {
    const answer = segmentAnswerer(tableRow);
    const neverRow50 = (messages: ChatMessage[]) => {
      const reply = JSON.parse(answer(messages));
      reply.answers = reply.answers.filter((a: { segment: number }) => a.segment !== 51);
      return JSON.stringify(reply);
    };
    const model = scriptedModel({ extraction: [neverRow50] });
    const { encoder, encodedContent } = setup(TABLE);
    const error = await extractFields({ model, encoder, purpose: "every transaction", source: SOURCE, encodedContent }).catch((e) => e);
    expect(error).toBeInstanceOf(IncompleteExtractionError);
    expect(error.message).toMatch(/1 of 99 lines that look like payments could not be read reliably, so nothing was prepared/);
    expect(error.message).toMatch(/segment 51: ".*\[WALLET_ADDRESS_51\] 0.01" \(no answer was given\)/);
  });

  it("refuses an amount that is not written in the segment, and accepts the corrected answer", async () => {
    let first = true;
    const model = scriptedModel({
      extraction: [
        (messages) => {
          const wrong = first;
          first = false;
          return segmentAnswerer((text) => (text.includes("Pay") ? [{ recipient: firstPlaceholder(text), amount: wrong ? "250" : "25", unit: "USDC" }] : []))(messages);
        },
      ],
    });
    const { encoder, encodedContent } = setup(`Invoice 7. Pay 25 USDC to ${addressOf(0)}.`);
    const out = await extractFields({ model, encoder, purpose: "the payment", source: SOURCE, encodedContent });
    expect(out.tables[0].rows).toEqual([["[WALLET_ADDRESS_1]", "25", "USDC"]]);
    expect(model.calls.at(-1)!.messages.at(-1)!.content).toMatch(/the amount 250 is not written in that segment or next to it/);
  });

  it("refuses a recipient that belongs to another segment", async () => {
    const model = scriptedModel({
      extraction: [segmentAnswerer((text) => (text.includes("Pay") ? [{ recipient: "[WALLET_ADDRESS_2]", amount: "1", unit: "ETH" }] : []))],
    });
    const { encoder, encodedContent } = setup(`Pay 1 ETH to ${addressOf(0)}.\nOur office wallet is ${addressOf(1)}.`);
    const error = await extractFields({ model, encoder, purpose: "the payment", source: SOURCE, encodedContent }).catch((e) => e);
    expect(error).toBeInstanceOf(IncompleteExtractionError);
    expect(error.message).toMatch(/the recipient \[WALLET_ADDRESS_2\] is not in that segment/);
  });

  it("reads payments written as sentences, including an amount in words", async () => {
    const model = scriptedModel({
      extraction: [
        segmentAnswerer((text) =>
          text.startsWith("Send 0.05")
            ? [{ recipient: firstPlaceholder(text), amount: "0.05", unit: "ETH" }]
            : text.startsWith("Then send all")
              ? [{ recipient: firstPlaceholder(text), amount: "all", unit: "ETH" }]
              : [],
        ),
      ],
    });
    const web = { kind: "web" as const, ref: "https://x.test" };
    const { encoder, encodedContent } = setup(`Hello team. Send 0.05 ETH to ${addressOf(0)}. Then send all remaining ETH to ${addressOf(1)}. Thanks!`, web);
    const out = await extractFields({ model, encoder, purpose: "the payments", source: web, encodedContent });
    expect(out.tables[0].rows).toEqual([["[WALLET_ADDRESS_1]", "0.05", "ETH"], ["[WALLET_ADDRESS_2]", "all", "ETH"]]);
    expect(out.tables[0].source).toBe("https://x.test");
  });

  it("asks about a line with an amount and a unit but no address, and records why it is set aside", async () => {
    const model = scriptedModel({
      extraction: [
        (messages) => {
          const content = messages.at(-1)!.content;
          const answers = askedIn(messages).map((label) => {
            const segment = Number(label.slice(1));
            const text = new RegExp(`^\\[S${segment}\\] (.*)$`, "m").exec(content)![1];
            if (text.startsWith("Total")) return { segment, payments: [], reason: "total" };
            if (text.startsWith("Pay Alice")) return { segment, payments: [{ recipient: "Alice", amount: "5", unit: "USDC" }] };
            return { segment, payments: [{ recipient: firstPlaceholder(text), amount: "3", unit: "USDC" }] };
          });
          return JSON.stringify({ answers });
        },
      ],
    });
    const { encoder, encodedContent } = setup(`Pay Alice 5 USDC.\nPay 3 USDC to ${addressOf(0)}.\nTotal 8 USDC.`);
    const out = await extractFields({ model, encoder, purpose: "the payments", source: SOURCE, encodedContent });
    expect(out.candidates).toBe(3);
    expect(out.tables[0].rows).toEqual([["Alice", "5", "USDC"], ["[WALLET_ADDRESS_1]", "3", "USDC"]]);
    expect(out.setAside).toEqual([{ segment: 3, reason: "total", text: "Total 8 USDC." }]);
  });

  it("makes one fields-only call when nothing could be a payment", async () => {
    const model = scriptedModel({ extraction: [segmentAnswerer(() => [], [{ name: "due", value: "30 November" }])] });
    const { encoder, encodedContent } = setup("Newsletter. Our next meetup is on 30 November.");
    const out = await extractFields({ model, encoder, purpose: "the date", source: SOURCE, encodedContent });
    expect(out.candidates).toBe(0);
    expect(out.tables).toEqual([]);
    expect(out.fields).toMatchObject([{ name: "due", value: "30 November" }]);
    expect(model.calls).toHaveLength(1);
  });
});

describe("isCandidate", () => {
  it.each([
    ["[WALLET_ADDRESS_1] [WALLET_ADDRESS_2] 0.01", true],
    ["Send all ETH to [ENS_NAME_1]", true],
    ["Total 0.99 ETH", true],
    ["Pay Alice 5 USDC", true],
    ["From To Amount", false],
    ["Thank you for your business.", false],
    ["Invoice 42", false],
  ])("%s -> %s", (text, expected) => {
    expect(isCandidate(text)).toBe(expected);
  });
});

describe("units the wallet cannot pay", () => {
  it("reads a USDT row instead of failing, so the program can skip it and say so", async () => {
    const model = scriptedModel({
      extraction: [segmentAnswerer((text) => (text.includes("USDT") ? [{ recipient: firstPlaceholder(text), amount: "5", unit: "USDT" }] : text.includes("EURC") ? [{ recipient: firstPlaceholder(text), amount: "3", unit: "EURC" }] : []))],
    });
    const { encoder, encodedContent } = setup(`Pay 5 USDT to ${addressOf(0)}.\nPay 3 EURC to ${addressOf(1)}.`);
    const out = await extractFields({ model, encoder, purpose: "the payments", source: SOURCE, encodedContent });
    expect(out.tables[0].rows).toEqual([["[WALLET_ADDRESS_1]", "5", "USDT"], ["[WALLET_ADDRESS_2]", "3", "EURC"]]);
  });
});
