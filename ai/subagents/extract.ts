import { splitSegments } from "@/injection-filter/segment";
import { CODE_PLACEHOLDER_TYPES, placeholderPattern, placeholderType } from "@/lib/placeholders";
import { EXTRACTION_CHUNK_CHARS, EXTRACTION_CONCURRENCY, MAX_TABLE_ROWS, SUPPORTED_UNITS } from "../config";
import { ModelOutputError, callJson } from "../model/call-json";
import type { ContentSource, ModelPort, TextEncoderPort } from "../ports";
import { fieldsExtractionMessages, segmentExtractionMessages, type SegmentWindow } from "../prompts";
import { extractionOutputSchema, segmentAnswersSchema, type ExternalField, type ExternalTable, type SetAsideReason } from "../schemas";

// The model half of the document subagents (web pages and PDFs alike).
//
// Payments are never copied out of a document by the model in one go: a model
// asked to transcribe 99 similar rows drops some, and nothing would notice.
// Instead:
//   1. The text is split into numbered segments (table lines, sentences) with
//      the same segmenter as the injection check.
//   2. Code picks every segment that could hold a payment: one with an address
//      or ENS placeholder, or with an amount and a unit. Code knows how many.
//   3. The model answers for each of those segments by number: its payments, or
//      none and why. It sees each segment with its neighbours, about 40 at a time.
//   4. Code checks the accounting: every candidate has an answer (missing ones
//      are asked again, then the request stops and names them), and every value
//      comes from the document: the recipient from that segment, the amount from
//      that segment or the one next to it, the unit from the document.
// The result is one "payments" table in document order, plus the segments set
// aside with their reason, so nothing disappears silently.

/** A document that lists more payments than one request can carry. The message is written for the user. */
export class TooManyRowsError extends Error {}
/** Some candidate segments still had no valid answer after asking again. The message is written for the user. */
export class IncompleteExtractionError extends Error {}

/** A candidate segment the model judged to hold no payment. `text` is the segment, encoded (placeholders, not addresses). */
export type SetAside = { segment: number; reason: SetAsideReason; text: string };
export type Extraction = {
  fields: ExternalField[];
  tables: ExternalTable[];
  /** Segments that could have held a payment, as counted by code. */
  candidates: number;
  /** Candidate segments the model judged to hold no payment. */
  setAside: SetAside[];
};

/** Candidate segments per model call. */
const BATCH = 40;
/** Times a candidate segment is asked about (the first time plus retries). */
const ROUNDS = 3;
/** Units that mark a line as a possible payment: the app's own, and common ones it cannot pay (so such rows are reported, not lost). */
const UNIT_WORD = new RegExp(`(?<![A-Za-z])(?:${[...SUPPORTED_UNITS, "ETHER", "WETH", "USDT", "DAI", "EUR", "USD"].join("|")})(?![A-Za-z])`, "i");
const ALL_WORDS = /\b(?:all|everything|rest|remaining|entire|whole)\b/i;

/** If `value` is only placeholders separated by commas, spaces, "and" or new lines, returns them; otherwise null. */
function splitPlaceholderList(value: string): string[] | null {
  const found = [...value.matchAll(placeholderPattern())].map((m) => m[0]);
  if (found.length < 2) return null;
  const rest = value.replace(placeholderPattern(), "").replace(/\band\b/gi, "");
  return /^[\s,;|]*$/.test(rest) ? found : null;
}

/** Splits text into pieces of at most `size` characters, at line breaks where possible. */
export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = current ? `\n${line}` : line;
    if (current.length + piece.length <= size) {
      current += piece;
      continue;
    }
    if (current) chunks.push(current);
    let rest = line;
    while (rest.length > size) {
      chunks.push(rest.slice(0, size));
      rest = rest.slice(size);
    }
    current = rest;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function inParallel<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const hasAddress = (text: string) => [...text.matchAll(placeholderPattern())].some((m) => CODE_PLACEHOLDER_TYPES.includes(m[1] as never));

/** A segment that could hold a payment: it names an address (or ENS name), or has an amount and a unit. */
export function isCandidate(text: string): boolean {
  return hasAddress(text) || (UNIT_WORD.test(text) && /\d/.test(text.replace(placeholderPattern(), "")));
}

/** "1,250.50" -> "1250.5", "007" -> "7": the same number written two ways compares equal. */
function canonical(number: string): string {
  const [whole, fraction = ""] = number.replace(/,/g, "").split(".");
  const w = whole.replace(/^0+(?=\d)/, "");
  const f = fraction.replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}

/** The numbers written in some text, placeholders' own digits excluded. */
const numbersIn = (text: string) => new Set([...text.replace(placeholderPattern(), " ").matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => canonical(m[0])));

type Payment = { recipient: string; amount: string; unit: string };

/** Problems with one segment's payments, checked against the document (empty = accepted). */
function checkPayments(payments: Payment[], segment: string, around: string, document: string): string[] {
  const problems: string[] = [];
  const numbers = numbersIn(around);
  for (const p of payments) {
    const type = placeholderType(p.recipient);
    if (type) {
      if (!CODE_PLACEHOLDER_TYPES.includes(type)) problems.push(`${p.recipient} cannot receive a payment`);
      else if (!segment.includes(p.recipient)) problems.push(`the recipient ${p.recipient} is not in that segment`);
    } else if (p.recipient.includes("[") || p.recipient.length < 2 || !segment.toLowerCase().includes(p.recipient.toLowerCase())) {
      problems.push(`the recipient "${p.recipient}" is not written in that segment`);
    }
    if (p.amount.toLowerCase() === "all") {
      if (!ALL_WORDS.test(around)) problems.push(`the amount "all" is not written in that segment`);
    } else if (!/^\d+(?:\.\d+)?$/.test(p.amount)) {
      problems.push(`the amount "${p.amount}" is not a plain decimal number`);
    } else if (!numbers.has(canonical(p.amount))) {
      problems.push(`the amount ${p.amount} is not written in that segment or next to it`);
    }
    // Any unit may be read, as long as it is written in the document: a unit the wallet
    // cannot pay (USDT, EUR...) reaches the program, which skips that row and says so.
    if (p.unit) {
      if (!/^[A-Za-z]{2,10}$/.test(p.unit)) problems.push(`the unit "${p.unit}" is not a currency symbol`);
      else if (!new RegExp(`(?<![A-Za-z])${p.unit}(?![A-Za-z])`, "i").test(document)) problems.push(`the unit ${p.unit} is not written in the document`);
    }
  }
  return problems;
}

export async function extractFields(args: {
  model: ModelPort;
  encoder: TextEncoderPort;
  purpose: string;
  source: ContentSource & { ref: string };
  encodedContent: string;
}): Promise<Extraction> {
  const { model, encoder, purpose, source, encodedContent } = args;
  // Safety net: values are encoded again before they reach the Coder. Normally a no-op.
  // Placeholders this document produced are kept; anything else that looks like one is neutralised.
  const encode = (value: string) => encoder.encode(value, source, { keepOwn: true });

  const segments = splitSegments(encodedContent).map((s, i) => ({ number: i + 1, text: s.text }));
  const candidates = segments.filter((s) => isCandidate(s.text)).map((s) => s.number);
  if (candidates.length > MAX_TABLE_ROWS) {
    throw new TooManyRowsError(
      `${source.ref} has ${candidates.length.toLocaleString("en-US")} lines that look like payments; one request can carry at most ${MAX_TABLE_ROWS.toLocaleString("en-US")}. Split the document, or ask for part of it (for example "rows 1 to 500").`,
    );
  }

  const rawFields: { name: string; value: string }[] = [];
  const accepted = new Map<number, Payment[]>();
  const setAside = new Map<number, SetAsideReason>();

  if (candidates.length === 0) {
    // Nothing that could be a payment: only single values are wanted.
    const reply = await callJson(model, "extraction", fieldsExtractionMessages(purpose, source.ref, chunkText(encodedContent, EXTRACTION_CHUNK_CHARS)[0]), extractionOutputSchema);
    rawFields.push(...reply.fields);
  } else {
    const textOf = (n: number) => segments[n - 1]?.text ?? "";
    const around = (n: number) => [textOf(n - 1), textOf(n), textOf(n + 1)].join("\n");
    const documentStart = encodedContent.slice(0, 800);
    const problems = new Map<number, string[]>();
    let pending = candidates;

    for (let round = 0; round < ROUNDS && pending.length > 0; round++) {
      const batches = Array.from({ length: Math.ceil(pending.length / BATCH) }, (_, i) => pending.slice(i * BATCH, (i + 1) * BATCH));
      await inParallel(batches, EXTRACTION_CONCURRENCY, async (batch) => {
        const inView = [...new Set(batch.flatMap((n) => [n - 1, n, n + 1]))].filter((n) => n >= 1 && n <= segments.length).sort((a, b) => a - b);
        const window: SegmentWindow = {
          segments: inView.map((n) => ({ number: n, text: textOf(n) })),
          ask: batch,
          documentStart: inView[0] > 3 ? documentStart : undefined,
          problems: batch.flatMap((n) => (problems.get(n) ?? []).map((p) => `S${n}: ${p}`)),
        };
        let reply;
        try {
          reply = await callJson(model, "extraction", segmentExtractionMessages(purpose, source.ref, window), segmentAnswersSchema);
        } catch (error) {
          if (!(error instanceof ModelOutputError)) throw error;
          for (const n of batch) problems.set(n, ["the reply was not valid JSON in the required form"]);
          return;
        }
        rawFields.push(...reply.fields);
        const asked = new Set(batch);
        for (const answer of reply.answers) {
          if (!asked.has(answer.segment) || accepted.has(answer.segment) || setAside.has(answer.segment)) continue;
          if (answer.payments.length === 0) {
            setAside.set(answer.segment, answer.reason ?? "other");
            problems.delete(answer.segment);
            continue;
          }
          const found = checkPayments(answer.payments, textOf(answer.segment), around(answer.segment), encodedContent);
          if (found.length === 0) {
            accepted.set(answer.segment, answer.payments);
            problems.delete(answer.segment);
          } else {
            problems.set(answer.segment, found);
          }
        }
        for (const n of batch) if (!accepted.has(n) && !setAside.has(n) && !problems.has(n)) problems.set(n, ["no answer was given"]);
      });
      pending = candidates.filter((n) => !accepted.has(n) && !setAside.has(n));
    }

    if (pending.length > 0) {
      const shown = pending.slice(0, 5).map((n) => `segment ${n}: "${textOf(n).slice(0, 90)}" (${(problems.get(n) ?? ["no answer"]).join("; ")})`);
      throw new IncompleteExtractionError(
        `I could not read every payment in ${source.ref}: ${pending.length} of ${candidates.length} lines that look like payments could not be read reliably, so nothing was prepared. ${shown.join(" ")}${pending.length > 5 ? ` …and ${pending.length - 5} more.` : ""}`,
      );
    }
  }

  const fields: ExternalField[] = [];
  const named = new Set<string>();
  for (const field of rawFields) {
    const value = encode(field.value);
    const parts = splitPlaceholderList(value);
    const entries = parts ? parts.map((part, i) => ({ name: `${field.name}_${i + 1}`, value: part })) : [{ name: field.name, value }];
    for (const entry of entries) {
      if (named.has(entry.name)) continue;
      named.add(entry.name);
      fields.push({ ...entry, origin: "external", source: source.ref });
    }
  }

  const rows = [...accepted]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, payments]) => payments.map((p) => [encode(p.recipient), p.amount.toLowerCase() === "all" ? "all" : p.amount, p.unit ? p.unit.toUpperCase().replace(/^ETHER$/, "ETH") : ""]));
  if (rows.length > MAX_TABLE_ROWS) {
    throw new TooManyRowsError(
      `${source.ref} lists ${rows.length.toLocaleString("en-US")} payments; one request can carry at most ${MAX_TABLE_ROWS.toLocaleString("en-US")}. Split the document, or ask for part of it (for example "rows 1 to 500").`,
    );
  }
  return {
    fields,
    tables: rows.length ? [{ name: "payments", columns: ["recipient", "amount", "unit"], rows, source: source.ref }] : [],
    candidates: candidates.length,
    setAside: [...setAside].sort((a, b) => a[0] - b[0]).map(([segment, reason]) => ({ segment, reason, text: segments[segment - 1]?.text ?? "" })),
  };
}
