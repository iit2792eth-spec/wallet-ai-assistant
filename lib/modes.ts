// What the user wants done with a request:
//   explain  describe what would happen; nothing is prepared or signed
//   prepare  build and show the transaction or message; nothing is signed
//   sign     carry it out, after approval (or within saved limits)
// Ordered from most to least cautious.
export const MODES = ["explain", "prepare", "sign"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABELS: Record<Mode, string> = {
  explain: "Explain only",
  prepare: "Prepare only",
  sign: "Sign after approval",
};

/** The more cautious of two modes. */
export function mostCautious(a: Mode, b: Mode): Mode {
  return MODES[Math.min(MODES.indexOf(a), MODES.indexOf(b))];
}

// Phrases in the user's own words that limit how far a request may go.
// Deliberately broad: a false match only makes a request more cautious.
const EXPLAIN_CUES =
  /\b(explain|what (would|will) happen|what happens if|what if|simulate|dry[- ]?run|hypothetical(ly)?|how would|would it|walk me through)\b/i;
const PREPARE_CUES =
  /\b(prepare|draft|preview|(do not|don'?t|dont) (send|sign|execute|submit|broadcast)|without (sending|signing|executing|submitting)|just (build|create|show))\b/i;

/**
 * The least cautious mode the user's own words allow. Decided in code, from the
 * user's messages only (never from web pages or PDFs), so neither the model nor
 * external content can raise it.
 */
export function modeCeiling(userText: string): Mode {
  if (EXPLAIN_CUES.test(userText)) return "explain";
  if (PREPARE_CUES.test(userText)) return "prepare";
  return "sign";
}
