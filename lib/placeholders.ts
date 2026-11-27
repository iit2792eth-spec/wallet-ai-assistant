// Placeholders are the only form in which the AI layer sees private values.
// The Text Encoder creates them, the Text Decoder restores the restorable ones,
// and everything in between treats them as opaque. Shared by all three.

export const PLACEHOLDER_TYPES = [
  "WALLET_ADDRESS",
  "ENS_NAME",
  "EMAIL",
  "PHONE",
  "INVALID_ADDRESS",
  "PRIVATE_KEY",
  "SEED_PHRASE",
] as const;
export type PlaceholderType = (typeof PLACEHOLDER_TYPES)[number];

/** Types generated code may contain, and the only ones the Text Decoder restores. */
export const CODE_PLACEHOLDER_TYPES: readonly PlaceholderType[] = ["WALLET_ADDRESS", "ENS_NAME"];
/** Types that are never restored and must never appear in any output. */
export const SECRET_PLACEHOLDER_TYPES: readonly PlaceholderType[] = ["PRIVATE_KEY", "SEED_PHRASE"];

const TYPES = PLACEHOLDER_TYPES.join("|");

/** New RegExp each call: global regexes carry state between uses. */
export const placeholderPattern = () => new RegExp(`\\[(${TYPES})_(\\d+)\\]`, "g");

const EXACT = new RegExp(`^\\[(${TYPES})_(\\d+)\\]$`);

export function placeholderType(value: string): PlaceholderType | null {
  return (EXACT.exec(value)?.[1] as PlaceholderType | undefined) ?? null;
}

const SECRET = new RegExp(`\\[(${SECRET_PLACEHOLDER_TYPES.join("|")})_\\d+\\]`);

export function containsSecretPlaceholder(text: string): boolean {
  return SECRET.test(text);
}

/** Matches pieces of a placeholder, used to catch split or altered ones. */
export const placeholderFragmentPattern = () =>
  /\[(WALLET|ENS|PRIVATE|SEED|EMAIL|PHONE|INVALID)_|_(ADDRESS|NAME|KEY|PHRASE)_\d|WALLET_ADDRESS|ENS_NAME|PRIVATE_KEY|SEED_PHRASE|INVALID_ADDRESS/;
