// Decides, in code, whether a chat message is text the user pasted rather than
// typed. The browser reports any paste or drop into the message box, even a short
// one; the text rules below also catch pastes the browser did not report. Pasted text (an email, a chat log, a web page) can carry someone else's
// instructions and addresses, including fake "earlier conversation" written to
// plant an address in the assistant's memory. Such messages are treated like a
// document: their addresses are never "typed by you", and the request always
// needs approval. The rules are deliberately broad: a false match only means an
// extra approval card.

export const PASTE_LENGTH = 300;

const MARKUP = /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i;
const TRANSCRIPT = /^\s*(user|me|you|assistant|ai|bot|agent|system|human|model|chatgpt|claude)\s*:/im;
const ADDRESS = /0x[0-9a-fA-F]{40}/;

/** clipboard: the browser saw text pasted or dropped into the message, however short. */
export type PasteReason = "clipboard" | "long" | "markup" | "transcript" | "multiline_address";

/**
 * Why a message counts as pasted (empty if it looks typed). `clipboard` comes from
 * the browser; the text rules also catch pastes the browser did not report.
 */
export function pasteReasons(text: string, options: { clipboard?: boolean } = {}): PasteReason[] {
  const reasons: PasteReason[] = options.clipboard ? ["clipboard"] : [];
  if (text.length > PASTE_LENGTH) reasons.push("long");
  if (MARKUP.test(text)) reasons.push("markup");
  if (TRANSCRIPT.test(text)) reasons.push("transcript");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length >= 3 && ADDRESS.test(text)) reasons.push("multiline_address");
  return reasons;
}

export const isPastedText = (text: string) => pasteReasons(text).length > 0;
