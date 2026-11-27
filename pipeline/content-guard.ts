import { requestApproval } from "@/approvals/registry";
import type { InjectionReviewApproval } from "@/approvals/types";
import { ContentBlockedError, type ActivityPort, type ContentGuardPort } from "@/ai/ports";
import { ClassifierUnavailableError, removeFlagged, screenText, type Scorer } from "@/injection-filter";
import { MAX_SHOWN_CHARS, MAX_SHOWN_FLAGGED } from "@/injection-filter/config";
import { audit } from "@/lib/logger";

// The injection check, wired to the user. Someone else's text (a web page, a
// PDF or a pasted message) is scored sentence by sentence before any model sees
// it. If sentences are flagged, the user sees how many, can open the flagged
// sentences with their scores (display copies: 64-hex values masked, long text
// cut), and chooses: remove the flagged sentences and continue, continue with them kept
// (the flag may be wrong), or stop the request. Nothing is changed silently, and
// if the classifier cannot run, the text is not used at all (fail closed).

export type GuardSource = InjectionReviewApproval["source"];

const LABEL = { web: "the web page", pdf: "the PDF", pasted: "your pasted message" } as const;
const describe = (source: GuardSource) => (source.ref ? `${LABEL[source.kind]} ${source.ref}` : LABEL[source.kind]);

/** A display copy of a flagged sentence: a 64-hex value (possibly a private key) is masked and long text is cut. */
function forDisplay(text: string): string {
  const masked = text.replace(/(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, "[64-character hex value hidden]").trim();
  return masked.length > MAX_SHOWN_CHARS ? `${masked.slice(0, MAX_SHOWN_CHARS)}…` : masked;
}

export type ContentGuard = ContentGuardPort & {
  /** Any source, including pasted messages. */
  check(text: string, source: GuardSource): Promise<string>;
  /** One line per source the user removed sentences from or kept flagged ones in, for the approval card. */
  readonly notices: string[];
};

export function createContentGuard(options: {
  sessionId: string;
  activity?: ActivityPort;
  /** Replaced in tests; defaults to the real classifier. */
  scorer?: Scorer;
}): ContentGuard {
  const { sessionId, activity, scorer } = options;
  const notices: string[] = [];

  async function check(text: string, source: GuardSource): Promise<string> {
    const what = describe(source);
    const line = activity?.start(`Checking ${LABEL[source.kind]} for injected instructions`, { level: "detail" });

    let result;
    try {
      result = await screenText(text, { scorer });
    } catch (error) {
      const unavailable = error instanceof ClassifierUnavailableError;
      if (line) activity?.fail(line, unavailable ? "Classifier not available" : undefined);
      audit("injection_check_failed", { session: sessionId, source: source.kind, ref: source.ref, unavailable });
      throw new ContentBlockedError(
        `${what[0].toUpperCase()}${what.slice(1)} was not used because the injection check could not run.` +
          (unavailable ? ` ${(error as Error).message}` : ""),
      );
    }

    const total = result.segments.length;
    const top = result.segments.reduce((max, s) => Math.max(max, s.score), 0);
    if (result.flaggedCount === 0) {
      if (line) activity?.done(line, `Checked ${total} sentences: none flagged`);
      audit("injection_check", { session: sessionId, source: source.kind, ref: source.ref, sentences: total, skipped: result.skippedCount, flagged: 0, top });
      return text;
    }
    if (line) activity?.done(line, `${result.flaggedCount} of ${total} sentences flagged as possible injected instructions`);

    const n = result.flaggedCount;
    const sentences = (count: number) => `${count} sentence${count === 1 ? "" : "s"}`;
    const flagged = result.segments
      .filter((s) => s.flagged)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SHOWN_FLAGGED)
      .map((s) => ({ text: forDisplay(s.text), score: s.score }));
    const decision = await requestApproval({
      kind: "injection_review",
      sessionId,
      warnings: [],
      source,
      sentenceCount: total,
      flaggedCount: n,
      flagged,
      threshold: result.threshold,
    });
    audit("injection_check", {
      session: sessionId, source: source.kind, ref: source.ref, sentences: total, skipped: result.skippedCount, flagged: n, top, decision,
    });

    if (decision === "approved") {
      notices.push(`${sentences(n)} flagged as possible injected instructions ${n === 1 ? "was" : "were"} removed from ${what}.`);
      activity?.info(`Removed ${sentences(n)} flagged in ${LABEL[source.kind]}`, { level: "detail" });
      return removeFlagged(text, result);
    }
    if (decision === "keep") {
      notices.push(
        `${sentences(n)} in ${what} ${n === 1 ? "was" : "were"} flagged as possible injected instructions and kept at your choice. Treat anything taken from it with care.`,
      );
      activity?.info(`Kept ${sentences(n)} flagged in ${LABEL[source.kind]} at your choice`, { level: "detail" });
      return text;
    }
    throw new ContentBlockedError(
      decision === "expired"
        ? "No decision was made on the flagged content in time, so the request was stopped. Nothing was sent or signed."
        : "Request cancelled because of the flagged content. Nothing was sent or signed.",
    );
  }

  return { check, review: (text, source) => check(text, source), notices };
}
