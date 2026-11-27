import { SECRET_PLACEHOLDER_TYPES, placeholderPattern, type PlaceholderType } from "@/lib/placeholders";
import { DETECTORS } from "./patterns";

// The Text Encoder (docs/Text_encoder.txt). Deterministic: a fixed set of
// pattern rules, no model. It replaces private values with numbered
// placeholders before any text reaches the AI layer, and keeps the originals
// in a mapping that only this module can read.
//
// Who can see what:
// - The AI layer gets the TextEncoderPort view: encode() and isKnownPlaceholder().
// - The Text Decoder gets a restore function for wallet addresses and ENS names only.
// - The user interface gets displayDecode(), which never reveals keys or seed phrases.
// The mapping itself is never returned, serialised or logged.

export type ContentSource =
  | { kind: "user" }
  /** A chat message the user pasted rather than typed (see lib/pasted.ts). */
  | { kind: "pasted" }
  | { kind: "web"; ref: string }
  | { kind: "pdf"; ref: string };

type Entry = {
  type: PlaceholderType;
  value: string;
  sources: Set<ContentSource["kind"]>;
  /** Exactly where it was seen: "user", "web:<url>" or "pdf:<file>". */
  origins: Set<string>;
};

const originOf = (source: ContentSource) =>
  source.kind === "user" || source.kind === "pasted" ? source.kind : `${source.kind}:${source.ref}`;

/** Types the Text Decoder may restore into code. */
const RESTORABLE: ReadonlySet<PlaceholderType> = new Set(["WALLET_ADDRESS", "ENS_NAME"]);

/** Same value, same placeholder. Addresses and ENS names are case-insensitive. */
function valueKey(type: PlaceholderType, value: string): string {
  const caseInsensitive = type === "WALLET_ADDRESS" || type === "ENS_NAME" || type === "EMAIL";
  return `${type}:${caseInsensitive ? value.toLowerCase() : value}`;
}

/** One chat session's placeholders. Private fields: there is no way to read the mapping from outside. */
export class MaskVault {
  #byPlaceholder = new Map<string, Entry>();
  #byValue = new Map<string, string>();
  #counters = new Map<PlaceholderType, number>();

  #placeholderFor(type: PlaceholderType, value: string, source: ContentSource): string {
    const key = valueKey(type, value);
    const existing = this.#byValue.get(key);
    if (existing) {
      const entry = this.#byPlaceholder.get(existing);
      entry?.sources.add(source.kind);
      entry?.origins.add(originOf(source));
      return existing;
    }
    const next = (this.#counters.get(type) ?? 0) + 1;
    this.#counters.set(type, next);
    const placeholder = `[${type}_${next}]`;
    this.#byValue.set(key, placeholder);
    this.#byPlaceholder.set(placeholder, { type, value, sources: new Set([source.kind]), origins: new Set([originOf(source)]) });
    return placeholder;
  }

  /**
   * Replaces every detected private value in `text` with its placeholder.
   *
   * Text that already looks like a placeholder is normally treated as an invalid
   * address, so a user or a page can never alias a real one. With `keepOwn`, a
   * placeholder this vault issued for the same source is kept as it is: used for
   * values a model extracted from an already-encoded document.
   */
  encode(text: string, source: ContentSource, options: { keepOwn?: boolean } = {}): string {
    const claimed: { start: number; end: number; type: PlaceholderType }[] = [];
    const kept: [number, number][] = [];
    const overlaps = (start: number, end: number) =>
      claimed.some((c) => start < c.end && end > c.start) || kept.some(([s, e]) => start < e && end > s);

    if (options.keepOwn) {
      const origin = originOf(source);
      for (const match of text.matchAll(placeholderPattern())) {
        if (this.#byPlaceholder.get(match[0])?.origins.has(origin)) kept.push([match.index, match.index + match[0].length]);
      }
    }
    for (const detector of DETECTORS) {
      for (const [start, end] of detector.find(text)) {
        if (!overlaps(start, end)) claimed.push({ start, end, type: detector.type });
      }
    }

    // Number placeholders in reading order, so the first address in the text is [WALLET_ADDRESS_1].
    claimed.sort((a, b) => a.start - b.start);
    let output = "";
    let cursor = 0;
    for (const { start, end, type } of claimed) {
      output += text.slice(cursor, start) + this.#placeholderFor(type, text.slice(start, end), source);
      cursor = end;
    }
    return output + text.slice(cursor);
  }

  isKnownPlaceholder(placeholder: string): boolean {
    return this.#byPlaceholder.has(placeholder);
  }

  /**
   * For the Text Decoder only: the original wallet address or ENS name for a
   * placeholder. Returns undefined for anything else, including keys and seed phrases.
   */
  restore(placeholder: string): string | undefined {
    const entry = this.#byPlaceholder.get(placeholder);
    return entry && RESTORABLE.has(entry.type) ? entry.value : undefined;
  }

  /**
   * For the access layer: where a wallet address or ENS name came from, without
   * revealing anything else in the mapping. "user" if the user ever typed it in
   * this session, otherwise "web" or "pdf" if it came from a document, or null
   * if the encoder never saw it (for example, an address read from the chain).
   */
  sourceOf(value: string): "user" | "pasted" | "web" | "pdf" | null {
    for (const type of ["WALLET_ADDRESS", "ENS_NAME"] as const) {
      const placeholder = this.#byValue.get(valueKey(type, value));
      const sources = placeholder ? this.#byPlaceholder.get(placeholder)?.sources : undefined;
      if (!sources) continue;
      if (sources.has("user")) return "user";
      if (sources.has("pasted")) return "pasted";
      return sources.has("web") ? "web" : "pdf";
    }
    return null;
  }

  /** The placeholder already issued for a wallet address or ENS name, or null. Issues nothing new. */
  placeholderOf(value: string): string | null {
    for (const type of ["WALLET_ADDRESS", "ENS_NAME"] as const) {
      const placeholder = this.#byValue.get(valueKey(type, value));
      if (placeholder) return placeholder;
    }
    return null;
  }

  /**
   * Whether a wallet address or ENS name was typed by the user, and whether it
   * appeared in someone else's text: a web page, a PDF, or a pasted message.
   */
  seenIn(value: string): { user: boolean; document: boolean } {
    for (const type of ["WALLET_ADDRESS", "ENS_NAME"] as const) {
      const placeholder = this.#byValue.get(valueKey(type, value));
      const sources = placeholder ? this.#byPlaceholder.get(placeholder)?.sources : undefined;
      if (sources) return { user: sources.has("user"), document: sources.has("web") || sources.has("pdf") || sources.has("pasted") };
    }
    return { user: false, document: false };
  }

  /**
   * Puts the user's own values back into text shown to the user, such as a
   * clarification question or a summary. Private keys and seed phrases stay masked.
   */
  displayDecode(text: string): string {
    return text.replace(placeholderPattern(), (placeholder) => {
      const entry = this.#byPlaceholder.get(placeholder);
      if (!entry || (SECRET_PLACEHOLDER_TYPES as readonly string[]).includes(entry.type)) return placeholder;
      return entry.value;
    });
  }

  /** Forgets every value. JavaScript strings cannot be overwritten in place; dropping all references is the most it can do. */
  clear(): void {
    this.#byPlaceholder.clear();
    this.#byValue.clear();
    this.#counters.clear();
  }

  /** Never serialise the mapping, even by accident (JSON.stringify, logging). */
  toJSON(): string {
    return "[MaskVault]";
  }
}

// One vault per chat session, in server memory only. Kept on globalThis so
// route handlers share it, including across dev reloads.
const globalForVaults = globalThis as unknown as { __maskVaults?: Map<string, MaskVault> };
const vaults = (globalForVaults.__maskVaults ??= new Map());

export function getVault(sessionId: string): MaskVault {
  let vault = vaults.get(sessionId);
  if (!vault) vaults.set(sessionId, (vault = new MaskVault()));
  return vault;
}

/** Clears and drops a session's mapping. Called when the session ends. */
export function clearVault(sessionId: string): void {
  vaults.get(sessionId)?.clear();
  vaults.delete(sessionId);
}

/**
 * True if the session's vault was created by an older version of this module.
 * Only happens in development: a code reload keeps existing vaults in memory,
 * and they keep running the old code.
 */
export function hasStaleVault(sessionId: string): boolean {
  const vault = vaults.get(sessionId);
  return vault !== undefined && !(vault instanceof MaskVault);
}

export function hasVault(sessionId: string): boolean {
  return vaults.has(sessionId);
}
