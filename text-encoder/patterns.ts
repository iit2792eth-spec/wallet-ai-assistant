import { english as BIP39_WORDS } from "viem/accounts";
import type { PlaceholderType } from "@/lib/placeholders";

// Detection rules, in the order they are applied: most specific first. Once a
// span of text is claimed by a rule, later rules cannot match inside it, so a
// 64-character private key is never also read as a 40-character address.

export type Detector = { type: PlaceholderType; find: (text: string) => [start: number, end: number][] };

const BIP39 = new Set(BIP39_WORDS);
const SEED_PHRASE_LENGTHS = [24, 21, 18, 15, 12];

/** Ranges matched by a global regex. */
const byRegex = (pattern: RegExp) => (text: string): [number, number][] =>
  [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);

/**
 * Hex boundaries: a match must not be part of a longer run of letters or digits,
 * so "0x" + 41 hex characters is not read as an address plus one character.
 */
const HEX_START = "(?<![0-9A-Za-z])";
const HEX_END = "(?![0-9A-Za-z])";

/** Consecutive BIP-39 words separated only by spaces, commas or line breaks. */
function findSeedPhrases(text: string): [number, number][] {
  const words = [...text.matchAll(/[A-Za-z]+/g)];
  const ranges: [number, number][] = [];
  let run: RegExpMatchArray[] = [];

  const flush = () => {
    // Take the longest valid seed length that fits, from the start of the run.
    let index = 0;
    while (run.length - index >= 12) {
      const length = SEED_PHRASE_LENGTHS.find((n) => n <= run.length - index)!;
      const first = run[index];
      const last = run[index + length - 1];
      ranges.push([first.index!, last.index! + last[0].length]);
      index += length;
    }
    run = [];
  };

  for (const word of words) {
    const isSeedWord = BIP39.has(word[0].toLowerCase());
    const previous = run.at(-1);
    const joined = previous !== undefined && /^[\s,]+$/.test(text.slice(previous.index! + previous[0].length, word.index!));
    if (!isSeedWord || (previous && !joined)) flush();
    if (isSeedWord) run.push(word);
  }
  flush();
  return ranges;
}

export const DETECTORS: Detector[] = [
  // Text that already looks like a placeholder did not come from this encoder.
  // It is treated as an invalid address so it can never alias a real placeholder.
  {
    type: "INVALID_ADDRESS",
    find: byRegex(/\[(?:WALLET_ADDRESS|ENS_NAME|EMAIL|PHONE|INVALID_ADDRESS|PRIVATE_KEY|SEED_PHRASE)_\d+\]/g),
  },
  // 1. Private key: 64 hex characters, with or without 0x.
  { type: "PRIVATE_KEY", find: byRegex(new RegExp(`${HEX_START}(?:0x)?[0-9a-fA-F]{64}${HEX_END}`, "g")) },
  // 2. Wallet address: 0x followed by exactly 40 hex characters.
  { type: "WALLET_ADDRESS", find: byRegex(new RegExp(`${HEX_START}0x[0-9a-fA-F]{40}${HEX_END}`, "g")) },
  // 3. Seed phrase: 12, 15, 18, 21 or 24 consecutive BIP-39 words.
  { type: "SEED_PHRASE", find: findSeedPhrases },
  // An attempt at an address that is not a valid one, e.g. 0x8u80275802 or a 39-character typo.
  { type: "INVALID_ADDRESS", find: byRegex(new RegExp(`${HEX_START}0x[0-9A-Za-z]{4,}${HEX_END}`, "g")) },
  { type: "EMAIL", find: byRegex(/(?<![\w.+-])[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?![\w-])/g) },
  { type: "ENS_NAME", find: byRegex(/(?<![\w.-])(?:[a-z0-9-]+\.)+eth(?![\w-])/gi) },
  {
    type: "PHONE",
    find: byRegex(/(?<![\w+])(?:\+\d[\d\s().-]{6,}\d|\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4})(?!\w)/g),
  },
];
