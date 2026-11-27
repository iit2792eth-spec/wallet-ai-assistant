import type { SetAsideLine } from "@/ai/schemas";

// Lines of a document that could have held a payment but were judged not to.
// They are listed on the first approval card, so a payment the model wrongly
// skipped is seen before anything is approved, not only in the activity stream.

const REASONS: Record<SetAsideLine["reason"], string> = {
  header: "a header",
  sender_only: "names only the sender",
  total: "a total",
  information: "no payment",
  instruction_to_ignore: "an instruction to the assistant, ignored",
  other: "not a payment",
};

/** Lines shown per document; the rest are counted. */
const MAX_SHOWN = 5;
/** Longest line text shown. */
const MAX_CHARS = 160;

/**
 * One notice per document, then one per line (at most MAX_SHOWN). `display`
 * turns placeholders back into the user's own values, for display only.
 */
export function setAsideNotices(lines: SetAsideLine[], display: (text: string) => string): string[] {
  const bySource = new Map<string, SetAsideLine[]>();
  for (const line of lines) bySource.set(line.source, [...(bySource.get(line.source) ?? []), line]);
  const notices: string[] = [];
  for (const [source, items] of bySource) {
    const n = items.length;
    notices.push(`${n === 1 ? "1 line" : `${n} lines`} in ${source} that may hold a payment ${n === 1 ? "was" : "were"} set aside and will not be paid. Check ${n === 1 ? "it" : "them"} against the document:`);
    for (const item of items.slice(0, MAX_SHOWN)) {
      const text = display(item.text).replace(/\s+/g, " ").trim();
      notices.push(`Line ${item.segment} (${REASONS[item.reason]}): "${text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text}"`);
    }
    if (n > MAX_SHOWN) notices.push(`…and ${n - MAX_SHOWN} more set aside in ${source}.`);
  }
  return notices;
}
