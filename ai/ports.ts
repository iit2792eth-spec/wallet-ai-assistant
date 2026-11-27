// Interfaces to components built outside the AI layer.

import type { ContentSource } from "@/text-encoder";

export type { ContentSource };

/**
 * The Text Encoder, as the AI layer sees it. The AI layer never reads the
 * encoder's mapping; it can only encode text and ask whether a placeholder exists.
 */
export interface TextEncoderPort {
  /** Replaces private values with placeholders. `source` records where the text came from. */
  encode(text: string, source: ContentSource, options?: { keepOwn?: boolean }): string;
  isKnownPlaceholder(placeholder: string): boolean;
}

/**
 * Reports progress to the user's activity stream. Optional everywhere: tests and
 * code that has no user to report to simply leave it out.
 */
export interface ActivityPort {
  /** Starts a line in the "running" state and returns its id. */
  start(text: string, options?: { level?: "step" | "detail" }): string;
  done(id: string, text?: string): void;
  fail(id: string, detail?: string): void;
  /** A line that is already complete. */
  info(text: string, options?: { level?: "step" | "detail" }): void;
}

/**
 * Checks someone else's text (a web page or PDF) for injected instructions
 * before it is encoded and shown to any model. Returns the text to use, which
 * may have sentences removed with the user's consent, or throws
 * ContentBlockedError if the text must not be used.
 */
export interface ContentGuardPort {
  review(text: string, source: { kind: "web" | "pdf"; ref: string }): Promise<string>;
}

/** The content guard stopped the request. The message is written for the user. */
export class ContentBlockedError extends Error {}

export type ChatMessage ={ role: "system" | "user" | "assistant"; content: string };

/** The tasks the AI layer asks a model to do. Lets tests script a reply per task. */
export type ModelTask = "planning" | "extraction" | "coding" | "review";

/** A chat model reduced to what the AI layer needs: messages in, text out. */
export interface ModelPort {
  invoke(task: ModelTask, messages: ChatMessage[]): Promise<string>;
}
