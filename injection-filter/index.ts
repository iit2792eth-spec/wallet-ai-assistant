import { INJECTION_THRESHOLD } from "./config";
import { scoreSentences } from "./classifier";
import { splitSegments, type Segment } from "./segment";
import { isWordless } from "./wordless";

// The injection filter (Chen et al., ACL 2025, segment-and-remove): split
// someone else's text into sentences, score each with the fine-tuned
// classifier, and let the user decide what happens to flagged sentences.
// Used on web pages, PDFs and pasted chat messages, never on typed ones.

export { ClassifierUnavailableError } from "./classifier";
export { splitSegments, type Segment } from "./segment";
export { INJECTION_THRESHOLD } from "./config";
export { isWordless } from "./wordless";

/** `skipped`: the segment has no words (see wordless.ts), so it was not scored; its score is 0. */
export type ScoredSegment = Segment & { score: number; flagged: boolean; skipped: boolean };

export type ScreenResult = {
  segments: ScoredSegment[];
  flaggedCount: number;
  /** Segments not scored because they contain no words. */
  skippedCount: number;
  threshold: number;
};

/** Scores a list of sentences; replaced by a stub in tests. */
export type Scorer = (texts: string[]) => Promise<number[]>;

/**
 * Splits text into sentences and scores every one that contains words; segments
 * with none (addresses, amounts, hashes) are skipped. Throws ClassifierUnavailableError if the model cannot run.
 */
export async function screenText(
  text: string,
  options: { scorer?: Scorer; threshold?: number } = {},
): Promise<ScreenResult> {
  const threshold = options.threshold ?? INJECTION_THRESHOLD;
  const segments = splitSegments(text);
  const skip = segments.map((segment) => isWordless(segment.text));
  const toScore = segments.filter((_, i) => !skip[i]).map((segment) => segment.text);
  const scores = toScore.length ? await (options.scorer ?? scoreSentences)(toScore) : [];
  let next = 0;
  const scored = segments.map((segment, i) => {
    if (skip[i]) return { ...segment, score: 0, flagged: false, skipped: true };
    const score = scores[next++];
    return { ...segment, score, flagged: score >= threshold, skipped: false };
  });
  return {
    segments: scored,
    flaggedCount: scored.filter((s) => s.flagged).length,
    skippedCount: scored.filter((s) => s.skipped).length,
    threshold,
  };
}

/**
 * The text without its flagged sentences. Everything else, including line
 * breaks and layout, is kept exactly; spaces left doubled by a cut are merged.
 */
export function removeFlagged(text: string, result: ScreenResult): string {
  let out = "";
  let cursor = 0;
  for (const segment of result.segments) {
    if (!segment.flagged) continue;
    out += text.slice(cursor, segment.start);
    cursor = segment.end;
    // "A. B. C." without B: drop the spaces after the cut if a space already precedes it.
    if (/[ \t]$/.test(out) || out === "") {
      while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor++;
    }
    // A cut at the end of a line leaves no trailing spaces behind.
    if (cursor === text.length || text[cursor] === "\n" || text[cursor] === "\r") out = out.replace(/[ \t]+$/, "");
  }
  return out + text.slice(cursor);
}
